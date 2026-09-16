create or replace function wf_private.capability_enabled_for(
  p_organization_id uuid,
  p_employee_id text,
  p_role text,
  p_capability text
)
returns boolean
language sql
stable
security definer
set search_path=''
as $function$
  select coalesce(
    (
      select employee_capability.enabled
      from public.workforce_employee_capabilities employee_capability
      where employee_capability.organization_id=p_organization_id
        and employee_capability.employee_id=p_employee_id
        and employee_capability.capability=p_capability
      limit 1
    ),
    (
      select role_capability.enabled
      from public.workforce_role_capabilities role_capability
      where role_capability.organization_id=p_organization_id
        and role_capability.role=p_role
        and role_capability.capability=p_capability
      limit 1
    ),
    false
  );
$function$;

revoke all on function wf_private.capability_enabled_for(uuid,text,text,text) from public, anon, authenticated;

create or replace function wf_private.effective_capabilities(
  p_organization_id uuid,
  p_employee_id text,
  p_role text
)
returns jsonb
language sql
stable
security definer
set search_path=''
as $function$
  select coalesce(jsonb_agg(effective.capability order by effective.capability),'[]'::jsonb)
  from (
    select coalesce(employee_capability.capability,role_capability.capability) as capability
    from (
      select capability,enabled
      from public.workforce_role_capabilities
      where organization_id=p_organization_id and role=p_role
    ) role_capability
    full join (
      select capability,enabled
      from public.workforce_employee_capabilities
      where organization_id=p_organization_id and employee_id=p_employee_id
    ) employee_capability using(capability)
    where coalesce(employee_capability.enabled,role_capability.enabled,false)
  ) effective;
$function$;

revoke all on function wf_private.effective_capabilities(uuid,text,text) from public, anon, authenticated;

create or replace function wf_private.capable(p_capability text)
returns boolean
language plpgsql
stable
security definer
set search_path=''
as $function$
declare
  actor public.employees%rowtype;
begin
  actor:=wf_private.actor();
  return wf_private.capability_enabled_for(
    actor.organization_id,actor.employee_id,actor.role,p_capability
  );
end;
$function$;

create or replace function wf_private.require_capability(p_capability text)
returns public.employees
language plpgsql
stable
security definer
set search_path=''
as $function$
declare
  actor public.employees%rowtype;
begin
  actor:=wf_private.actor();
  if not wf_private.capability_enabled_for(
    actor.organization_id,actor.employee_id,actor.role,p_capability
  ) then
    raise exception 'Không có quyền thực hiện thao tác này.' using errcode='42501';
  end if;
  return actor;
end;
$function$;

create or replace function wf_private.scope_ids()
returns setof text
language plpgsql
stable
security definer
set search_path=''
as $function$
declare
  actor public.employees%rowtype;
  can_team boolean;
  can_all boolean;
begin
  actor:=wf_private.actor();
  can_team:=wf_private.capability_enabled_for(
    actor.organization_id,actor.employee_id,actor.role,'team.read'
  );
  can_all:=wf_private.capability_enabled_for(
    actor.organization_id,actor.employee_id,actor.role,'team.read_all'
  );

  return query
  select employee.employee_id
  from public.employees employee
  where employee.organization_id=actor.organization_id
    and (
      employee.employee_id=actor.employee_id
      or (
        can_team
        and (
          can_all
          or employee.direct_manager_id=actor.employee_id
          or employee.center_id=any(actor.managed_locations)
        )
      )
    );
end;
$function$;

create or replace function wf_private.employee_capable(
  p_organization_id uuid,
  p_employee_id text,
  p_capability text
)
returns boolean
language plpgsql
stable
security definer
set search_path=''
as $function$
declare
  employee_role text;
begin
  select employee.role into employee_role
  from public.employees employee
  where employee.organization_id=p_organization_id
    and employee.employee_id=p_employee_id
    and employee.status='Active';

  if employee_role is null then return false; end if;
  return wf_private.capability_enabled_for(
    p_organization_id,p_employee_id,employee_role,p_capability
  );
end;
$function$;

create or replace function wf_private.approval_role_allowed(
  p_organization_id uuid,
  p_request_type text
)
returns boolean
language plpgsql
stable
security definer
set search_path=''
as $function$
declare
  actor public.employees%rowtype;
begin
  actor:=wf_private.actor();
  return actor.organization_id=p_organization_id
    and wf_private.capability_enabled_for(
      actor.organization_id,actor.employee_id,actor.role,'team.read'
    )
    and wf_private.capability_enabled_for(
      actor.organization_id,actor.employee_id,actor.role,'attendance.review'
    )
    and wf_private.approval_role_configured(
      actor.organization_id,actor.role,p_request_type
    );
end;
$function$;

create or replace function wf_private.bootstrap_fast(p jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  actor public.employees%rowtype;
  current_sheet public.timesheets%rowtype;
  policy public.attendance_policies%rowtype;
  planned_assignment public.shift_assignments%rowtype;
  shift public.config_shifts%rowtype;
  planned jsonb;
  receipt jsonb;
  summary jsonb;
  capabilities jsonb;
  first_day date:=coalesce(
    (p->>'from')::date,
    date_trunc('month',clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date
  );
  today date:=(clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date;
  org_timezone text;
begin
  actor:=wf_private.actor();
  org_timezone:=wf_private.organization_timezone(actor.organization_id);
  capabilities:=wf_private.effective_capabilities(
    actor.organization_id,actor.employee_id,actor.role
  );

  select * into current_sheet
  from public.timesheets
  where employee_id=actor.employee_id
    and (
      (actual_checkin is not null and actual_checkout is null and status not in ('LOCKED','CANCELLED'))
      or work_date=today
    )
  order by (actual_checkin is not null and actual_checkout is null) desc,work_date desc
  limit 1;

  select * into policy
  from public.attendance_policies
  where id=actor.attendance_policy_id and active;

  select * into planned_assignment
  from public.shift_assignments
  where employee_id=actor.employee_id
    and work_date=today
    and publication_status='PUBLISHED';

  if planned_assignment.id is not null then
    select * into shift
    from public.config_shifts
    where id=planned_assignment.shift_id
      and organization_id=actor.organization_id;
  end if;

  planned:=jsonb_build_object(
    'work_date',today,
    'shift_name',coalesce(shift.name,policy.name),
    'location_id',coalesce(planned_assignment.location_id,actor.center_id),
    'expected_start',(today+coalesce(shift.start_time,policy.expected_start)) at time zone 'Asia/Ho_Chi_Minh',
    'expected_end',(
      today+coalesce(shift.end_time,policy.expected_end)
      + case
          when coalesce(shift.end_time,policy.expected_end)<=coalesce(shift.start_time,policy.expected_start)
            then interval '1 day'
          else interval '0 day'
        end
    ) at time zone 'Asia/Ho_Chi_Minh',
    'scheduled',planned_assignment.id is not null
      or extract(isodow from today)::smallint=any(policy.work_days)
  );

  select payload->'receipt' into receipt
  from public.workforce_receipts
  where employee_id=actor.employee_id
  order by created_at desc
  limit 1;

  select jsonb_build_object(
    'work_minutes',coalesce(sum(work_minutes) filter(
      where status in ('COMPLETE','AUTO_APPROVED','APPROVED','LOCKED')
    ),0),
    'exceptions',count(*) filter(
      where status in ('EXCEPTION','PENDING_REVIEW','REJECTED')
    ),
    'days',count(*) filter(where actual_checkin is not null),
    'remaining_leave',coalesce(actor.annual_leave_balance,0)
  ) into summary
  from public.timesheets
  where employee_id=actor.employee_id
    and work_date between first_day and today
    and status not in ('SCHEDULED','CANCELLED');

  return jsonb_build_object(
    'version',4,
    'server_time',clock_timestamp(),
    'profile',to_jsonb(actor),
    'capabilities',capabilities,
    'today',case when current_sheet.id is null then null else to_jsonb(current_sheet) end,
    'planned',planned,
    'latest_receipt',receipt,
    'summary',summary,
    'unread',(
      select count(*)
      from public.workforce_notifications
      where employee_id=actor.employee_id and read_at is null
    ),
    'policy',case when policy.id is null then null else to_jsonb(policy) end,
    'timezone',org_timezone,
    'local_date',wf_private.organization_local_date(actor.organization_id,clock_timestamp()),
    'sessions_today',(
      select coalesce(jsonb_agg(to_jsonb(session) order by session.session_sequence),'[]'::jsonb)
      from public.work_sessions session
      where session.organization_id=actor.organization_id
        and session.employee_internal_id=actor.internal_id
        and session.business_date=today
        and session.status<>'CANCELLED'
    ),
    'active_session',(
      select to_jsonb(session)
      from public.work_sessions session
      where session.organization_id=actor.organization_id
        and session.employee_internal_id=actor.internal_id
        and session.status='OPEN'
      order by session.actual_checkin desc
      limit 1
    )
  );
end;
$function$;

revoke all on function wf_private.bootstrap_fast(jsonb) from public, anon, authenticated;

create or replace function wf_private.metadata_fast(p jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  actor public.employees%rowtype;
  today date;
  org_timezone text;
  can_read_all boolean;
  can_schedule boolean;
begin
  actor:=wf_private.actor();
  org_timezone:=wf_private.organization_timezone(actor.organization_id);
  today:=wf_private.organization_local_date(actor.organization_id,clock_timestamp());
  can_read_all:=wf_private.capability_enabled_for(
    actor.organization_id,actor.employee_id,actor.role,'team.read_all'
  );
  can_schedule:=wf_private.capability_enabled_for(
    actor.organization_id,actor.employee_id,actor.role,'schedule.manage'
  );

  return jsonb_build_object(
    'shifts',(
      select coalesce(jsonb_agg(to_jsonb(shift) order by shift.sort_order),'[]'::jsonb)
      from public.config_shifts shift
      where shift.organization_id=actor.organization_id and shift.active
    ),
    'locations',(
      select coalesce(jsonb_agg(to_jsonb(location) order by location.center_name),'[]'::jsonb)
      from public.locations location
      where location.organization_id=actor.organization_id
        and location.active
        and (
          can_read_all
          or location.center_id=actor.center_id
          or location.center_id=any(actor.allowed_locations)
          or location.center_id=any(actor.managed_locations)
        )
    ),
    'holidays',(
      select coalesce(jsonb_agg(to_jsonb(holiday) order by holiday.from_date),'[]'::jsonb)
      from public.holidays holiday
      where holiday.organization_id=actor.organization_id
        and holiday.active
        and holiday.to_date>=today-366
        and holiday.from_date<=today+366
    ),
    'templates',(
      select coalesce(jsonb_agg(to_jsonb(template) order by template.name),'[]'::jsonb)
      from public.workforce_schedule_templates template
      where template.organization_id=actor.organization_id
        and can_schedule
    ),
    'timezone',org_timezone,
    'local_date',today,
    'system_settings',(
      select coalesce(jsonb_agg(
        jsonb_build_object('key',setting.key,'value',setting.value)
        order by setting.key
      ),'[]'::jsonb)
      from public.config_system setting
      where setting.organization_id=actor.organization_id
        and setting.key=any(array[
          'MIN_HOURS_FULL','MIN_HOURS_HALF','LUNCH_START','LUNCH_END','APPROVAL_ROLES'
        ]::text[])
    ),
    'location_directory',(
      select coalesce(jsonb_agg(
        jsonb_build_object(
          'center_id',location.center_id,
          'center_name',location.center_name,
          'city',location.city,
          'active',location.active
        ) order by location.center_name,location.center_id
      ),'[]'::jsonb)
      from public.locations location
      where location.organization_id=actor.organization_id
    ),
    'qr_timing',jsonb_build_object(
      'refresh_seconds',coalesce((
        select setting.value::integer
        from public.config_system setting
        where setting.organization_id=actor.organization_id
          and setting.key='QR_REFRESH_SECONDS'
      ),30),
      'validity_seconds',coalesce((
        select setting.value::integer
        from public.config_system setting
        where setting.organization_id=actor.organization_id
          and setting.key='QR_VALIDITY_SECONDS'
      ),45)
    ),
    'config_revision',coalesce((
      select version.revision
      from public.organization_config_versions version
      where version.organization_id=actor.organization_id
    ),1)
  );
end;
$function$;

revoke all on function wf_private.metadata_fast(jsonb) from public, anon, authenticated;

create or replace function public.workforce_query(
  p_resource text,
  p_args jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
begin
  if p_resource='bootstrap' then
    return wf_private.bootstrap_fast(p_args);
  elsif p_resource='metadata' then
    return wf_private.metadata_fast(p_args);
  elsif p_resource=any(array[
    'history','requests','directory','admin.people','admin.schedule',
    'admin.sessions','admin.requests','admin.audit','admin.devices'
  ]::text[]) then
    return wf_private.query_commercial(p_resource,p_args);
  elsif p_resource=any(array[
    'request.detail','assignment.detail','admin.config','workflow',
    'commercial_config','privacy','observability'
  ]::text[]) then
    return wf_private.query_ga(p_resource,p_args);
  else
    return wf_private.query_v4(p_resource,p_args);
  end if;
end;
$function$;
