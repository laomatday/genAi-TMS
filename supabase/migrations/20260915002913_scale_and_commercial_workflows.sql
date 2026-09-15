-- Scale and commercial workflow layer.
set local lock_timeout='5s';
set local statement_timeout='180s';

-- ---------------------------------------------------------------------------
-- Keyset-paged resources. Offset remains accepted by the legacy private query,
-- while every new public request for large collections uses an opaque cursor.
-- ---------------------------------------------------------------------------
create or replace function wf_private.query_commercial(
  p_resource text,
  p jsonb default '{}'
)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  actor public.employees%rowtype;
  rows jsonb:='[]'::jsonb;
  page_size integer:=least(100,greatest(1,coalesce((p->>'size')::integer,30)));
  has_more boolean:=false;
  cursor jsonb:=coalesce(p->'cursor','{}');
  cursor_date date;
  cursor_time timestamptz;
  cursor_id uuid;
  cursor_name text;
  state text:=lower(coalesce(p->>'state','all'));
  needle text:='%'||replace(replace(coalesce(p->>'q',''),'%','\%'),'_','\_')||'%';
  team boolean:=coalesce((p->>'team')::boolean,false);
begin
  actor:=wf_private.actor();
  if p_resource='history' then
    cursor_date:=coalesce((cursor->>'business_date')::date,'infinity'::date);
    cursor_id:=coalesce((cursor->>'id')::uuid,'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid);
    select coalesce(jsonb_agg(to_jsonb(page) order by page.business_date desc,page.id desc),'[]')
    into rows
    from (
      select session.*,employee.name as employee_name,location.center_name as location_name
      from public.work_sessions session
      join public.employees employee
        on employee.organization_id=session.organization_id
       and employee.internal_id=session.employee_internal_id
      left join public.locations location
        on location.organization_id=session.organization_id
       and location.internal_id=session.location_internal_id
      where session.organization_id=actor.organization_id
        and session.employee_id in(select wf_private.scope_ids())
        and (team or session.employee_internal_id=actor.internal_id)
        and (session.business_date,session.id)<(cursor_date,cursor_id)
        and session.business_date between coalesce((p->>'from')::date,'1900-01-01'::date)
                                      and coalesce((p->>'to')::date,'infinity'::date)
        and (state='all' or lower(session.status)=state)
        and (employee.name ilike needle or employee.employee_code ilike needle)
        and session.status<>'CANCELLED'
      order by session.business_date desc,session.id desc
      limit page_size+1
    ) page;
  elsif p_resource='requests' then
    cursor_time:=coalesce((cursor->>'created_at')::timestamptz,'infinity'::timestamptz);
    cursor_id:=coalesce((cursor->>'id')::uuid,'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid);
    select coalesce(jsonb_agg(to_jsonb(page) order by page.created_at desc,page.id desc),'[]')
    into rows
    from (
      select request.*,employee.name as employee_name,owner.name as owner_name
      from public.attendance_requests request
      join public.employees employee
        on employee.employee_id=request.employee_id
       and employee.organization_id=request.organization_id
      left join public.employees owner
        on owner.employee_id=request.assigned_to
       and owner.organization_id=request.organization_id
      where request.organization_id=actor.organization_id
        and (
          request.employee_id=actor.employee_id
          or request.workflow_data->>'peer_employee_id'=actor.employee_id
          or (
            team and request.employee_id in(select wf_private.scope_ids())
            and wf_private.approval_role_allowed(request.organization_id,request.request_type)
          )
        )
        and (request.created_at,request.id)<(cursor_time,cursor_id)
        and request.from_date<=coalesce((p->>'to')::date,'infinity'::date)
        and request.to_date>=coalesce((p->>'from')::date,'1900-01-01'::date)
        and (state='all' or lower(request.status)=state)
        and (employee.name ilike needle or request.reason ilike needle or request.request_code ilike needle)
      order by request.created_at desc,request.id desc
      limit page_size+1
    ) page;
  elsif p_resource='directory' then
    perform wf_private.require_capability('directory.read');
    cursor_name:=coalesce(cursor->>'name','');
    cursor_id:=coalesce((cursor->>'id')::uuid,'00000000-0000-0000-0000-000000000000'::uuid);
    select coalesce(jsonb_agg(to_jsonb(page) order by page.sort_name,page.internal_id),'[]')
    into rows
    from (
      select employee.internal_id,employee.employee_code,employee.employee_id,
        employee.name,employee.email,employee.phone,employee.position,
        employee.department,employee.center_id,employee.avatar_url,
        employee.role,employee.direct_manager_id,
        employee.status,lower(employee.name) as sort_name
      from public.employees employee
      where employee.organization_id=actor.organization_id
        and employee.role<>'Kiosk'
        and (lower(employee.name),employee.internal_id)>(cursor_name,cursor_id)
        and (state='all' or lower(employee.status)=state)
        and (employee.name ilike needle or employee.employee_code ilike needle or employee.email ilike needle)
      order by lower(employee.name),employee.internal_id
      limit page_size+1
    ) page;
  elsif p_resource='admin.people' then
    perform wf_private.require_capability('employee.manage');
    cursor_name:=coalesce(cursor->>'name','');
    cursor_id:=coalesce((cursor->>'id')::uuid,'00000000-0000-0000-0000-000000000000'::uuid);
    select coalesce(jsonb_agg(to_jsonb(page) order by page.sort_name,page.internal_id),'[]')
    into rows
    from (
      select employee.*,lower(employee.name) as sort_name
      from public.employees employee
      where employee.organization_id=actor.organization_id
        and (lower(employee.name),employee.internal_id)>(cursor_name,cursor_id)
        and (state='all' or lower(employee.status)=state)
        and (employee.name ilike needle or employee.employee_code ilike needle or employee.email ilike needle)
      order by lower(employee.name),employee.internal_id
      limit page_size+1
    ) page;
  elsif p_resource='admin.schedule' then
    perform wf_private.require_capability('schedule.manage');
    cursor_date:=coalesce((cursor->>'work_date')::date,'infinity'::date);
    cursor_id:=coalesce((cursor->>'id')::uuid,'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid);
    select coalesce(jsonb_agg(to_jsonb(page) order by page.work_date desc,page.id desc),'[]')
    into rows
    from (
      select assignment.*,employee.name as employee_name,
        shift.name as shift_name,shift.start_time,shift.end_time,
        location.center_name as location_name
      from public.shift_assignments assignment
      join public.employees employee
        on employee.organization_id=assignment.organization_id
       and employee.internal_id=assignment.employee_internal_id
      join public.config_shifts shift
        on shift.organization_id=assignment.organization_id
       and shift.internal_id=assignment.shift_internal_id
      left join public.locations location
        on location.organization_id=assignment.organization_id
       and location.internal_id=assignment.location_internal_id
      where assignment.organization_id=actor.organization_id
        and assignment.employee_id in(select wf_private.scope_ids())
        and (assignment.work_date,assignment.id)<(cursor_date,cursor_id)
        and assignment.work_date between coalesce((p->>'from')::date,'1900-01-01'::date)
                                         and coalesce((p->>'to')::date,'infinity'::date)
      order by assignment.work_date desc,assignment.id desc
      limit page_size+1
    ) page;
  elsif p_resource in ('admin.sessions','admin.requests','admin.audit','admin.devices') then
    if p_resource in ('admin.sessions','admin.requests') and not(
      wf_private.capable('team.read_all')
      and (
        wf_private.capable('attendance.review')
        or wf_private.capable('attendance.export')
      )
    ) then raise exception 'Không có quyền đọc dữ liệu chấm công toàn tổ chức.' using errcode='42501';
    elsif p_resource='admin.audit' and not wf_private.capable('audit.view') then
      raise exception 'Không có quyền xem nhật ký kiểm toán.' using errcode='42501';
    elsif p_resource='admin.devices' and not wf_private.capable('employee.manage') then
      raise exception 'Không có quyền quản lý thiết bị.' using errcode='42501';
    end if;
    cursor_time:=coalesce((cursor->>'created_at')::timestamptz,'infinity'::timestamptz);
    cursor_id:=coalesce((cursor->>'id')::uuid,'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid);
    if p_resource='admin.sessions' then
      select coalesce(jsonb_agg(to_jsonb(page) order by page.created_at desc,page.id desc),'[]') into rows
      from (
        select session.*,employee.name as employee_name
        from public.work_sessions session
        join public.employees employee
          on employee.organization_id=session.organization_id
         and employee.internal_id=session.employee_internal_id
        where session.organization_id=actor.organization_id
          and (session.created_at,session.id)<(cursor_time,cursor_id)
          and session.business_date between coalesce(
            (p->>'from')::date,
            wf_private.organization_local_date(actor.organization_id,clock_timestamp())-31
          ) and coalesce(
            (p->>'to')::date,
            wf_private.organization_local_date(actor.organization_id,clock_timestamp())
          )
        order by session.created_at desc,session.id desc limit page_size+1
      ) page;
    elsif p_resource='admin.requests' then
      select coalesce(jsonb_agg(to_jsonb(page) order by page.created_at desc,page.id desc),'[]') into rows
      from (
        select request.*,employee.name as employee_name
        from public.attendance_requests request
        join public.employees employee
          on employee.employee_id=request.employee_id
         and employee.organization_id=request.organization_id
        where request.organization_id=actor.organization_id
          and (request.created_at,request.id)<(cursor_time,cursor_id)
          and (state='all' or lower(request.status)=state)
          and request.from_date<=coalesce((p->>'to')::date,'infinity'::date)
          and request.to_date>=coalesce((p->>'from')::date,'1900-01-01'::date)
        order by request.created_at desc,request.id desc limit page_size+1
      ) page;
    elsif p_resource='admin.audit' then
      perform wf_private.require_capability('audit.view');
      select coalesce(jsonb_agg(to_jsonb(page) order by page.created_at desc,page.id desc),'[]') into rows
      from (
        select audit.* from public.audit_logs audit
        where audit.organization_id=actor.organization_id
          and (audit.created_at,audit.id)<(cursor_time,cursor_id)
        order by audit.created_at desc,audit.id desc limit page_size+1
      ) page;
    else
      perform wf_private.require_capability('employee.manage');
      select coalesce(jsonb_agg(to_jsonb(page) order by page.sort_time desc,page.internal_id desc),'[]') into rows
      from (
        select device.*,employee.name as employee_name,
          employee.internal_id,
          coalesce(device.activated_at,device.created_at) as sort_time
        from public.trusted_devices device
        join public.employees employee
          on employee.employee_id=device.employee_id
         and employee.organization_id=device.organization_id
        where device.organization_id=actor.organization_id
          and (coalesce(device.activated_at,device.created_at),employee.internal_id)<(cursor_time,cursor_id)
        order by coalesce(device.activated_at,device.created_at) desc,employee.internal_id desc
        limit page_size+1
      ) page;
    end if;
  else
    return wf_private.query_v4(p_resource,p);
  end if;

  has_more:=jsonb_array_length(rows)>page_size;
  if has_more then rows:=rows-(-1); end if;
  return jsonb_build_object(
    'rows',rows,'has_more',has_more,'size',page_size,
    'next_cursor',case
      when not has_more or jsonb_array_length(rows)=0 then null
      when p_resource in ('history','admin.schedule') then jsonb_build_object(
        case when p_resource='history' then 'business_date' else 'work_date' end,
        rows->(jsonb_array_length(rows)-1)->>
          case when p_resource='history' then 'business_date' else 'work_date' end,
        'id',rows->(jsonb_array_length(rows)-1)->>'id'
      )
      when p_resource in ('directory','admin.people') then jsonb_build_object(
        'name',rows->(jsonb_array_length(rows)-1)->>'sort_name',
        'id',rows->(jsonb_array_length(rows)-1)->>'internal_id'
      )
      when p_resource='admin.devices' then jsonb_build_object(
        'created_at',rows->(jsonb_array_length(rows)-1)->>'sort_time',
        'id',rows->(jsonb_array_length(rows)-1)->>'internal_id'
      )
      else jsonb_build_object(
        'created_at',rows->(jsonb_array_length(rows)-1)->>'created_at',
        'id',coalesce(
          rows->(jsonb_array_length(rows)-1)->>'id',
          rows->(jsonb_array_length(rows)-1)->>'internal_id'
        )
      )
    end,
    'cache',jsonb_build_object(
      'resource',p_resource,'server_time',clock_timestamp(),
      'ttl_seconds',case when p_resource in ('history','requests','admin.audit') then 30 else 300 end
    )
  );
end;
$$;
revoke all on function wf_private.query_commercial(text,jsonb)
from public,anon,authenticated,service_role;

create or replace function public.workforce_query(
  p_resource text,
  p_args jsonb default '{}'
)
returns jsonb
language sql
security invoker
set search_path=''
as $$ select wf_private.query_commercial(p_resource,p_args) $$;
revoke all on function public.workforce_query(text,jsonb) from public,anon;
grant execute on function public.workforce_query(text,jsonb) to authenticated;
grant execute on function wf_private.query_commercial(text,jsonb) to authenticated;

-- Indexes are paired with the keyset predicates above; the release benchmark
-- records EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) before promotion.
create index if not exists work_sessions_history_keyset_idx
  on public.work_sessions(organization_id,employee_internal_id,business_date desc,id desc)
  where status<>'CANCELLED';
create index if not exists attendance_requests_keyset_idx
  on public.attendance_requests(organization_id,created_at desc,id desc);
create index if not exists employees_directory_keyset_idx
  on public.employees(organization_id,lower(name),internal_id)
  where role<>'Kiosk';
create index if not exists audit_logs_keyset_idx
  on public.audit_logs(organization_id,created_at desc,id desc);

alter table public.work_sessions
  add column paid_leave_minutes integer not null default 0
    check(paid_leave_minutes>=0);

-- ---------------------------------------------------------------------------
-- Small, independently claimable maintenance jobs. No worker scans every
-- tenant/employee in one transaction; competing workers use SKIP LOCKED.
-- ---------------------------------------------------------------------------
create table wf_private.maintenance_jobs(
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  work_date date not null,
  bucket_at timestamptz not null,
  state text not null default 'PENDING'
    check(state in ('PENDING','PROCESSING','SUCCEEDED','FAILED')),
  attempts integer not null default 0 check(attempts between 0 and 20),
  available_at timestamptz not null default clock_timestamp(),
  lease_token uuid,
  leased_at timestamptz,
  lease_expires_at timestamptz,
  completed_at timestamptz,
  changed integer not null default 0,
  error_code text,
  created_at timestamptz not null default clock_timestamp(),
  unique(organization_id,work_date,bucket_at)
);
create index maintenance_jobs_claim_idx
  on wf_private.maintenance_jobs(state,available_at,id)
  where state in ('PENDING','FAILED');
alter table wf_private.maintenance_jobs enable row level security;
revoke all on table wf_private.maintenance_jobs from public,anon,authenticated,service_role;
revoke all on sequence wf_private.maintenance_jobs_id_seq from public,anon,authenticated,service_role;

create or replace function wf_private.enqueue_maintenance_jobs(
  p_now timestamptz default clock_timestamp()
)
returns integer
language plpgsql
security definer
set search_path=''
as $$
declare inserted integer;
begin
  insert into wf_private.maintenance_jobs(
    organization_id,work_date,bucket_at
  )
  select organization.id,
    wf_private.organization_local_date(organization.id,p_now)-offset_day,
    date_trunc('hour',p_now)
  from public.organizations organization
  cross join generate_series(0,1) offset_day
  on conflict(organization_id,work_date,bucket_at) do nothing;
  get diagnostics inserted=row_count;
  return inserted;
end;
$$;
revoke all on function wf_private.enqueue_maintenance_jobs(timestamptz)
from public,anon,authenticated,service_role;

create or replace function wf_private.maintain_day_set_based(
  p_organization_id uuid,
  p_work_date date,
  p_now timestamptz default clock_timestamp()
)
returns integer
language plpgsql
security definer
set search_path=''
as $$
declare changed integer:=0; affected integer;
begin
  perform wf_private.period_lock(p_organization_id,p_work_date,p_work_date,false);
  if exists(
    select 1 from public.attendance_periods period
    where period.organization_id=p_organization_id and period.status='CLOSED'
      and p_work_date between period.period_start and period.period_end
  ) then return 0; end if;

  -- Published assignments are materialized idempotently in bounded batches.
  insert into public.work_sessions(
    organization_id,employee_internal_id,employee_id,assignment_id,business_date,
    session_sequence,policy_id,location_internal_id,location_id,expected_start,
    expected_end,status,source
  )
  select assignment.organization_id,assignment.employee_internal_id,
    assignment.employee_id,assignment.id,assignment.work_date,
    row_number() over(
      partition by assignment.organization_id,assignment.employee_internal_id,assignment.work_date
      order by assignment.scheduled_start,assignment.id
    )::smallint,
    employee.attendance_policy_id,assignment.location_internal_id,
    coalesce(assignment.location_id,employee.center_id),assignment.scheduled_start,
    assignment.scheduled_end,'SCHEDULED','NORMAL'
  from public.shift_assignments assignment
  join public.employees employee
    on employee.organization_id=assignment.organization_id
   and employee.internal_id=assignment.employee_internal_id
  where assignment.organization_id=p_organization_id
    and assignment.work_date=p_work_date
    and assignment.publication_status='PUBLISHED'
    and employee.status='Active'
  on conflict(organization_id,assignment_id) where assignment_id is not null
  do update set expected_start=excluded.expected_start,
    expected_end=excluded.expected_end,location_internal_id=excluded.location_internal_id,
    location_id=excluded.location_id,
    status=case when public.work_sessions.actual_checkin is null then 'SCHEDULED' else public.work_sessions.status end
  where (
    public.work_sessions.expected_start,
    public.work_sessions.expected_end,
    public.work_sessions.location_internal_id,
    public.work_sessions.location_id,
    public.work_sessions.status
  ) is distinct from (
    excluded.expected_start,
    excluded.expected_end,
    excluded.location_internal_id,
    excluded.location_id,
    case when public.work_sessions.actual_checkin is null then 'SCHEDULED' else public.work_sessions.status end
  );
  get diagnostics affected=row_count;
  changed:=changed+affected;

  -- Materialize the policy-based day even when there is no explicit shift.
  -- Full-day leave/holiday becomes approved evidence; partial leave preserves
  -- the requirement to check in for the remaining part of the day.
  with expected as (
    select employee.organization_id,employee.internal_id as employee_internal_id,
      employee.employee_id,employee.attendance_policy_id as policy_id,
      location.internal_id as location_internal_id,employee.center_id as location_id,
      wf_private.organization_instant(
        employee.organization_id,p_work_date,policy.expected_start
      ) as expected_start,
      wf_private.organization_instant(
        employee.organization_id,
        p_work_date+case when policy.expected_end<=policy.expected_start then 1 else 0 end,
        policy.expected_end
      ) as expected_end,
      policy.checkin_window_end,policy.expected_start as policy_start,
      policy.unpaid_break_minutes,
      holiday.id as holiday_id,holiday.paid as holiday_paid,
      leave_request.id as leave_request_id,
      leave_request.request_type as leave_type,
      leave_request.duration_unit,
      leave_request.requested_minutes
    from public.employees employee
    join public.attendance_policies policy
      on policy.organization_id=employee.organization_id
     and policy.id=employee.attendance_policy_id and policy.active
    left join public.locations location
      on location.organization_id=employee.organization_id
     and location.center_id=employee.center_id
    left join lateral(
      select current_holiday.id,current_holiday.paid
      from public.holidays current_holiday
      where current_holiday.organization_id=employee.organization_id
        and current_holiday.active
        and p_work_date between current_holiday.from_date and current_holiday.to_date
      order by current_holiday.id limit 1
    ) holiday on true
    left join lateral(
      select request.id,request.request_type,request.duration_unit,request.requested_minutes
      from public.attendance_requests request
      where request.organization_id=employee.organization_id
        and request.employee_id=employee.employee_id
        and request.status='APPROVED'
        -- Remote work and business trips are work-location modes, not an
        -- automatic attendance exemption. A future tenant policy may opt out
        -- explicitly; until then only actual leave types suppress attendance.
        and request.request_type in(
          'ANNUAL_LEAVE','SICK_LEAVE','UNPAID_LEAVE'
        )
        and p_work_date between request.from_date and request.to_date
      order by request.created_at desc,request.id desc limit 1
    ) leave_request on true
    where employee.organization_id=p_organization_id
      and employee.status='Active' and employee.role<>'Kiosk'
      and p_work_date>=coalesce(
        employee.employment_start_date,
        wf_private.organization_local_date(employee.organization_id,employee.created_at)
      )
      and (employee.employment_end_date is null or p_work_date<=employee.employment_end_date)
      and extract(isodow from p_work_date)::smallint=any(policy.work_days)
      and not exists(
        select 1 from public.shift_assignments assignment
        where assignment.organization_id=employee.organization_id
          and assignment.employee_internal_id=employee.internal_id
          and assignment.work_date=p_work_date
          and assignment.publication_status='PUBLISHED'
      )
  ), prepared as (
    select expected.*,
      greatest(0,
        floor(extract(epoch from(expected.expected_end-expected.expected_start))/60)::integer
        -expected.unpaid_break_minutes
      ) as standard_minutes,
      expected.expected_start+(expected.checkin_window_end-expected.policy_start) as deadline,
      coalesce(expected.duration_unit,'DAYS')='DAYS' as full_day_leave
    from expected
  )
  insert into public.work_sessions(
    organization_id,employee_internal_id,employee_id,business_date,
    session_sequence,policy_id,location_internal_id,location_id,
    expected_start,expected_end,status,source,exception_codes,paid_leave_minutes
  )
  select prepared.organization_id,prepared.employee_internal_id,
    prepared.employee_id,p_work_date,1,prepared.policy_id,
    prepared.location_internal_id,prepared.location_id,
    prepared.expected_start,prepared.expected_end,
    case
      when prepared.holiday_id is not null then 'APPROVED'
      when prepared.leave_request_id is not null and prepared.full_day_leave then 'APPROVED'
      when p_now>prepared.deadline then 'NEEDS_REVIEW'
      else 'SCHEDULED'
    end,'NORMAL',
    case
      when prepared.holiday_id is not null then array['HOLIDAY']
      when prepared.leave_request_id is not null and prepared.full_day_leave then array['APPROVED_LEAVE']
      when prepared.leave_request_id is not null then
        case when p_now>prepared.deadline
          then array['PARTIAL_LEAVE','MISSING_CHECKIN']
          else array['PARTIAL_LEAVE'] end
      when p_now>prepared.deadline then array['MISSING_CHECKIN']
      else '{}'::text[]
    end,
    case
      when prepared.leave_type='ANNUAL_LEAVE' and prepared.full_day_leave
        then prepared.standard_minutes
      when prepared.leave_type='ANNUAL_LEAVE'
        then least(prepared.standard_minutes,coalesce(prepared.requested_minutes,0))
      else 0
    end
  from prepared
  where prepared.holiday_id is not null
     or prepared.leave_request_id is not null
     or p_now>=prepared.expected_start-interval '15 minutes'
  on conflict(organization_id,employee_internal_id,business_date,session_sequence)
  do update set
    policy_id=excluded.policy_id,
    location_internal_id=excluded.location_internal_id,
    location_id=excluded.location_id,
    expected_start=excluded.expected_start,
    expected_end=excluded.expected_end,
    status=excluded.status,
    exception_codes=excluded.exception_codes,
    paid_leave_minutes=excluded.paid_leave_minutes
  where public.work_sessions.assignment_id is null
    and public.work_sessions.actual_checkin is null
    and public.work_sessions.status not in ('LOCKED','PENDING_REVIEW','REJECTED')
    and (
      public.work_sessions.policy_id,
      public.work_sessions.location_internal_id,
      public.work_sessions.location_id,
      public.work_sessions.expected_start,
      public.work_sessions.expected_end,
      public.work_sessions.status,
      public.work_sessions.exception_codes,
      public.work_sessions.paid_leave_minutes
    ) is distinct from (
      excluded.policy_id,
      excluded.location_internal_id,
      excluded.location_id,
      excluded.expected_start,
      excluded.expected_end,
      excluded.status,
      excluded.exception_codes,
      excluded.paid_leave_minutes
    );
  get diagnostics affected=row_count;
  changed:=changed+affected;

  update public.work_sessions session
  set status='NEEDS_REVIEW',
      exception_codes=array(
        select distinct code
        from unnest(coalesce(session.exception_codes,'{}')||array['MISSING_CHECKOUT']) code
      ),
      break_minutes=session.break_minutes+case
        when session.break_started_at is null then 0
        else greatest(0,floor(extract(epoch from(p_now-session.break_started_at))/60)::integer)
      end,
      break_started_at=null
  where session.organization_id=p_organization_id
    and session.business_date=p_work_date
    and session.status='OPEN'
    and session.actual_checkout is null
    and p_now>coalesce(session.expected_end,session.actual_checkin+interval '16 hours')+interval '15 minutes';
  get diagnostics affected=row_count;
  changed:=changed+affected;

  -- Rebuild the compatibility day aggregate from canonical sessions. The
  -- DISTINCT predicate prevents hourly maintenance from bumping revisions.
  insert into public.timesheets(
    employee_id,work_date,policy_id,location_id,expected_start,expected_end,
    actual_checkin,actual_checkout,status,source,exception_codes,late_minutes,
    early_minutes,work_minutes,paid_leave_minutes,break_minutes
  )
  select session.employee_id,session.business_date,
    (array_agg(session.policy_id order by session.session_sequence))[1],
    (array_agg(session.location_id order by session.session_sequence))[1],
    min(session.expected_start),max(session.expected_end),min(session.actual_checkin),
    case when bool_or(session.status='OPEN') then null else max(session.actual_checkout) end,
    case
      when bool_or(session.status in ('NEEDS_REVIEW','PENDING_REVIEW','REJECTED')) then 'EXCEPTION'
      when bool_or(session.status='OPEN') then 'OPEN'
      when bool_and(session.status in ('APPROVED','AUTO_APPROVED')) then 'APPROVED'
      when bool_and(session.status='SCHEDULED') then 'SCHEDULED'
      else 'COMPLETE'
    end,
    case when bool_or(session.source='ADJUSTED') then 'ADJUSTED' else 'NORMAL' end,
    coalesce(array(
      select distinct code
      from public.work_sessions source_session,
           unnest(source_session.exception_codes) code
      where source_session.organization_id=p_organization_id
        and source_session.employee_internal_id=session.employee_internal_id
        and source_session.business_date=p_work_date
      order by code
    ),'{}'),
    sum(session.late_minutes)::integer,sum(session.early_minutes)::integer,
    sum(session.work_minutes)::integer,sum(session.paid_leave_minutes)::integer,
    sum(session.break_minutes)::integer
  from public.work_sessions session
  where session.organization_id=p_organization_id
    and session.business_date=p_work_date and session.status<>'CANCELLED'
  group by session.organization_id,session.employee_internal_id,
    session.employee_id,session.business_date
  on conflict(employee_id,work_date) do update
  set policy_id=excluded.policy_id,location_id=excluded.location_id,
      expected_start=excluded.expected_start,expected_end=excluded.expected_end,
      actual_checkin=excluded.actual_checkin,actual_checkout=excluded.actual_checkout,
      status=excluded.status,source=excluded.source,
      exception_codes=excluded.exception_codes,late_minutes=excluded.late_minutes,
      early_minutes=excluded.early_minutes,work_minutes=excluded.work_minutes,
      paid_leave_minutes=excluded.paid_leave_minutes,
      break_minutes=excluded.break_minutes
  where public.timesheets.status<>'LOCKED'
    and (
      public.timesheets.policy_id,public.timesheets.location_id,
      public.timesheets.expected_start,public.timesheets.expected_end,
      public.timesheets.actual_checkin,public.timesheets.actual_checkout,
      public.timesheets.status,public.timesheets.source,
      public.timesheets.exception_codes,public.timesheets.late_minutes,
      public.timesheets.early_minutes,public.timesheets.work_minutes,
      public.timesheets.paid_leave_minutes,public.timesheets.break_minutes
    ) is distinct from (
      excluded.policy_id,excluded.location_id,excluded.expected_start,
      excluded.expected_end,excluded.actual_checkin,excluded.actual_checkout,
      excluded.status,excluded.source,excluded.exception_codes,
      excluded.late_minutes,excluded.early_minutes,excluded.work_minutes,
      excluded.paid_leave_minutes,excluded.break_minutes
    );
  get diagnostics affected=row_count;
  changed:=changed+affected;

  insert into public.workforce_notifications(
    organization_id,employee_id,dedupe_key,kind,title,body,context
  )
  select session.organization_id,session.employee_id,
    left('checkin:'||session.id::text,200),'CHECKIN_REMINDER',
    'Sắp đến giờ làm việc','Kiểm tra lịch và chấm công khi đến nơi.',
    jsonb_build_object('date',session.business_date,'work_session_id',session.id)
  from public.work_sessions session
  where session.organization_id=p_organization_id
    and session.business_date=p_work_date and session.status='SCHEDULED'
    and session.actual_checkin is null
    and p_now between session.expected_start-interval '15 minutes'
                  and session.expected_start+interval '4 hours'
  on conflict(employee_id,dedupe_key) do nothing;

  insert into public.workforce_notifications(
    organization_id,employee_id,dedupe_key,kind,title,body,context
  )
  select session.organization_id,session.employee_id,
    left('checkout:'||session.id::text,200),'CHECKOUT_REMINDER',
    'Ca làm đã kết thúc','Bạn còn ca chưa check-out.',
    jsonb_build_object('date',session.business_date,'work_session_id',session.id)
  from public.work_sessions session
  where session.organization_id=p_organization_id
    and session.business_date=p_work_date and session.status='OPEN'
    and session.actual_checkout is null and p_now>session.expected_end
  on conflict(employee_id,dedupe_key) do nothing;

  -- Keep the compatibility aggregate aligned without touching raw events.
  update public.timesheets timesheet
  set status='EXCEPTION',
      exception_codes=array(
        select distinct code
        from unnest(coalesce(timesheet.exception_codes,'{}')||array['MISSING_CHECKOUT']) code
      )
  where timesheet.organization_id=p_organization_id
    and timesheet.work_date=p_work_date
    and timesheet.actual_checkout is null
    and exists(
      select 1 from public.work_sessions session
      where session.organization_id=timesheet.organization_id
        and session.employee_id=timesheet.employee_id
        and session.business_date=timesheet.work_date
        and session.status='NEEDS_REVIEW'
        and 'MISSING_CHECKOUT'=any(session.exception_codes)
    )
    and timesheet.status not in ('LOCKED','PENDING_REVIEW','REJECTED')
    and (
      timesheet.status is distinct from 'EXCEPTION'
      or not('MISSING_CHECKOUT'=any(coalesce(timesheet.exception_codes,'{}')))
    );
  get diagnostics affected=row_count;
  changed:=changed+affected;

  -- Move both the request and its active workflow step to the same valid
  -- fallback. Otherwise the inbox changes owner while authorization remains
  -- attached to the previous step.
  update public.workflow_steps step
  set assigned_employee_internal_id=fallback.internal_id
  from public.workflow_instances instance
  join public.attendance_requests request on request.id=instance.request_id
  join public.employees fallback
    on fallback.organization_id=request.organization_id
   and fallback.employee_id=request.fallback_to
   and fallback.status='Active'
   and fallback.auth_user_id is not null
   and wf_private.employee_approval_eligible(
     request.organization_id,fallback.employee_id,
     request.request_type,request.employee_id
   )
  where step.instance_id=instance.id and step.status='ACTIVE'
    and wf_private.employee_capable(
      request.organization_id,fallback.employee_id,step.capability
    )
    and request.organization_id=p_organization_id
    and request.status='PENDING' and request.due_at<p_now
    and request.escalated_at is null
    and request.fallback_to is distinct from request.employee_id;

  with escalated as (
    update public.attendance_requests request
    set assigned_to=coalesce((
          select employee.employee_id
          from public.employees employee
          where employee.organization_id=request.organization_id
            and employee.employee_id=request.fallback_to
            and employee.status='Active'
            and employee.auth_user_id is not null
            and employee.employee_id<>request.employee_id
            and wf_private.employee_approval_eligible(
              request.organization_id,employee.employee_id,
              request.request_type,request.employee_id
            )
          limit 1
        ),request.assigned_to),
        escalated_at=p_now
    where request.organization_id=p_organization_id
      and request.status='PENDING'
      and request.due_at<p_now
      and request.escalated_at is null
    returning request.id
  ) select count(*) into affected from escalated;
  changed:=changed+affected;

  insert into public.workforce_notifications(
    organization_id,employee_id,dedupe_key,kind,title,body,context
  )
  select request.organization_id,request.assigned_to,
    left('overdue:'||request.id::text,200),'REQUEST_OVERDUE',
    'Yêu cầu đã quá hạn xử lý','Vui lòng xử lý yêu cầu trong hàng chờ.',
    jsonb_build_object('request_id',request.id)
  from public.attendance_requests request
  where request.organization_id=p_organization_id
    and request.status='PENDING' and request.escalated_at=p_now
    and request.assigned_to is not null
  on conflict(employee_id,dedupe_key) do nothing;
  return changed;
end;
$$;
revoke all on function wf_private.maintain_day_set_based(uuid,date,timestamptz)
from public,anon,authenticated,service_role;

create or replace function wf_private.run_maintenance_batch(
  p_max_jobs integer default 8
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  job wf_private.maintenance_jobs%rowtype;
  lease uuid;
  affected integer;
  succeeded integer:=0;
  failed integer:=0;
  total_changed integer:=0;
begin
  p_max_jobs:=least(20,greatest(1,p_max_jobs));
  perform wf_private.enqueue_maintenance_jobs();
  for job in
    select candidate.*
    from wf_private.maintenance_jobs candidate
    where candidate.state in ('PENDING','FAILED')
      and candidate.available_at<=clock_timestamp()
      and candidate.attempts<20
    order by candidate.available_at,candidate.id
    limit p_max_jobs
    for update skip locked
  loop
    lease:=extensions.gen_random_uuid();
    update wf_private.maintenance_jobs
    set state='PROCESSING',lease_token=lease,leased_at=clock_timestamp(),
        attempts=attempts+1,error_code=null
    where id=job.id;
    begin
      affected:=wf_private.maintain_day_set_based(
        job.organization_id,job.work_date,clock_timestamp()
      );
      update wf_private.maintenance_jobs
      set state='SUCCEEDED',completed_at=clock_timestamp(),changed=affected
      where id=job.id and lease_token=lease;
      succeeded:=succeeded+1;
      total_changed:=total_changed+affected;
    exception when others then
      update wf_private.maintenance_jobs
      set state='FAILED',error_code=sqlstate,
          available_at=clock_timestamp()+make_interval(mins=>least(60,power(2,attempts)::integer))
      where id=job.id and lease_token=lease;
      failed:=failed+1;
    end;
  end loop;
  return jsonb_build_object(
    'ok',failed=0,'succeeded',succeeded,'failed',failed,
    'changed',total_changed,'run_at',clock_timestamp()
  );
end;
$$;
revoke all on function wf_private.run_maintenance_batch(integer)
from public,anon,authenticated,service_role;

create or replace function wf_private.run_automation()
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
begin
  return wf_private.run_maintenance_batch(8);
end;
$$;
revoke all on function wf_private.run_automation()
from public,anon,authenticated,service_role;

-- Tenant users must never be able to trigger a worker that claims jobs across
-- organizations. Only the trusted service worker receives this public entry
-- point; browser commands explicitly reject `maintenance.run` below.
create or replace function public.workforce_maintenance_worker_v1(
  p_max_jobs integer default 8
)
returns jsonb
language sql
security definer
set search_path=''
as $$
  select wf_private.run_maintenance_batch(
    least(20,greatest(1,coalesce(p_max_jobs,8)))
  );
$$;
revoke all on function public.workforce_maintenance_worker_v1(integer)
from public,anon,authenticated;
grant execute on function public.workforce_maintenance_worker_v1(integer)
to service_role;

-- ---------------------------------------------------------------------------
-- Versioned multi-level approval definitions, instances and delegation.
-- Decisions are immutable evidence.
-- ---------------------------------------------------------------------------
-- A globally unique UUID is not a tenant boundary.  Every tenant-owned parent
-- exposed below also has an (organization_id,id) candidate key so child rows
-- can prove that their organization matches the referenced row.
alter table public.attendance_requests
  add constraint attendance_requests_organization_id_key
  unique(organization_id,id);

create table public.workflow_definitions(
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  request_type text not null,
  version integer not null check(version>0),
  name text not null check(char_length(name) between 1 and 160),
  active boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  created_by text references public.employees(employee_id) on delete set null,
  constraint workflow_definitions_organization_id_key
    unique(organization_id,id),
  unique(organization_id,request_type,version)
);
create unique index workflow_definitions_one_active
  on public.workflow_definitions(organization_id,request_type)
  where active;

create table public.workflow_definition_steps(
  definition_id uuid not null references public.workflow_definitions(id) on delete cascade,
  step_no smallint not null check(step_no between 1 and 20),
  role text not null check(role in ('Leader','Manager','Director','HR','Admin')),
  capability text not null default 'attendance.review',
  due_hours integer not null default 24 check(due_hours between 1 and 720),
  primary key(definition_id,step_no)
);

create table public.workflow_instances(
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  definition_id uuid not null,
  definition_version integer not null,
  request_id uuid not null unique,
  state text not null default 'ACTIVE' check(state in ('ACTIVE','APPROVED','REJECTED','CANCELLED')),
  current_step smallint not null default 1,
  created_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  constraint workflow_instances_organization_id_key
    unique(organization_id,id),
  constraint workflow_instances_definition_tenant_fk
    foreign key(organization_id,definition_id)
    references public.workflow_definitions(organization_id,id) on delete restrict,
  constraint workflow_instances_request_tenant_fk
    foreign key(organization_id,request_id)
    references public.attendance_requests(organization_id,id) on delete restrict
);

create table public.workflow_steps(
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  instance_id uuid not null,
  step_no smallint not null,
  role text not null,
  capability text not null,
  due_hours integer not null check(due_hours between 1 and 720),
  assigned_employee_internal_id uuid,
  status text not null default 'PENDING' check(status in ('PENDING','ACTIVE','APPROVED','REJECTED','SKIPPED')),
  due_at timestamptz,
  activated_at timestamptz,
  completed_at timestamptz,
  constraint workflow_steps_organization_id_key
    unique(organization_id,id),
  unique(instance_id,step_no),
  check(status<>'ACTIVE' or due_at is not null),
  constraint workflow_steps_instance_tenant_fk
    foreign key(organization_id,instance_id)
    references public.workflow_instances(organization_id,id) on delete restrict,
  foreign key(organization_id,assigned_employee_internal_id)
    references public.employees(organization_id,internal_id) on delete restrict
);
create index workflow_steps_queue_idx
  on public.workflow_steps(organization_id,status,due_at,assigned_employee_internal_id)
  where status='ACTIVE';

create table public.workflow_decisions(
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  instance_id uuid not null,
  step_id uuid not null,
  actor_employee_internal_id uuid not null,
  delegated_from_internal_id uuid,
  decision text not null check(decision in ('APPROVED','REJECTED')),
  reason text not null default '',
  context jsonb not null default '{}',
  created_at timestamptz not null default clock_timestamp(),
  unique(step_id),
  constraint workflow_decisions_instance_tenant_fk
    foreign key(organization_id,instance_id)
    references public.workflow_instances(organization_id,id) on delete restrict,
  constraint workflow_decisions_step_tenant_fk
    foreign key(organization_id,step_id)
    references public.workflow_steps(organization_id,id) on delete restrict,
  foreign key(organization_id,actor_employee_internal_id)
    references public.employees(organization_id,internal_id) on delete restrict,
  foreign key(organization_id,delegated_from_internal_id)
    references public.employees(organization_id,internal_id) on delete restrict
);

create table public.workflow_delegations(
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  from_employee_internal_id uuid not null,
  to_employee_internal_id uuid not null,
  request_types text[] not null default '{}',
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  reason text not null check(char_length(reason) between 5 and 500),
  revoked_at timestamptz,
  created_by_internal_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  check(ends_at>starts_at and ends_at-starts_at<=interval '180 days'),
  check(from_employee_internal_id<>to_employee_internal_id),
  foreign key(organization_id,from_employee_internal_id)
    references public.employees(organization_id,internal_id) on delete restrict,
  foreign key(organization_id,to_employee_internal_id)
    references public.employees(organization_id,internal_id) on delete restrict,
  foreign key(organization_id,created_by_internal_id)
    references public.employees(organization_id,internal_id) on delete restrict
);
create index workflow_delegations_active_idx
  on public.workflow_delegations(organization_id,to_employee_internal_id,starts_at,ends_at)
  where revoked_at is null;

do $$
declare relation text;
begin
  foreach relation in array array[
    'workflow_definitions','workflow_definition_steps','workflow_instances',
    'workflow_steps','workflow_decisions','workflow_delegations'
  ] loop
    execute format('alter table public.%I enable row level security',relation);
    execute format(
      'revoke all on table public.%I from public,anon,authenticated,service_role',
      relation
    );
  end loop;
end;
$$;

create policy workflow_instances_read_scope
on public.workflow_instances for select to authenticated
using(
  organization_id=(select wf_private.current_organization())
  and exists(
    select 1 from public.attendance_requests request
    where request.id=workflow_instances.request_id
      and (request.employee_id=(select tms_private.current_employee_id())
        or (select tms_private.can_manage_employee(request.employee_id)))
  )
);
create policy workflow_steps_read_tenant on public.workflow_steps for select to authenticated
using(organization_id=(select wf_private.current_organization()));
create policy workflow_decisions_read_tenant on public.workflow_decisions for select to authenticated
using(organization_id=(select wf_private.current_organization()));
create policy workflow_delegations_read_tenant on public.workflow_delegations for select to authenticated
using(
  organization_id=(select wf_private.current_organization())
  and (
    from_employee_internal_id=(select internal_id from public.employees where auth_user_id=(select auth.uid()))
    or to_employee_internal_id=(select internal_id from public.employees where auth_user_id=(select auth.uid()))
    or (select wf_private.capable('attendance.review'))
  )
);

create or replace function wf_private.prevent_workflow_decision_mutation()
returns trigger language plpgsql security definer set search_path=''
as $$ begin raise exception 'Quyết định phê duyệt là bằng chứng bất biến.' using errcode='42501'; end $$;
revoke all on function wf_private.prevent_workflow_decision_mutation()
from public,anon,authenticated,service_role;
create trigger workflow_decisions_immutable
before update or delete or truncate on public.workflow_decisions
for each statement execute function wf_private.prevent_workflow_decision_mutation();

-- Default policies are explicit and versioned. Tenant admins may publish newer
-- definitions through a controlled migration/command in a later release.
insert into public.workflow_definitions(organization_id,request_type,version,name)
select organization.id,kind.request_type,1,kind.name
from public.organizations organization
cross join(values
  ('ATTENDANCE','Giải trình và điều chỉnh công'),
  ('TIME_OFF','Nghỉ phép'),
  ('OVERTIME','Tăng ca'),
  ('SHIFT_SWAP','Đổi ca'),
  ('BUSINESS','Công tác và làm việc từ xa')
) kind(request_type,name)
on conflict(organization_id,request_type,version) do nothing;

insert into public.workflow_definition_steps(definition_id,step_no,role,capability,due_hours)
select definition.id,step.step_no,step.role,'attendance.review',step.due_hours
from public.workflow_definitions definition
join lateral(
  select * from (values
    (1::smallint,'Manager'::text,24),
    (2::smallint,'HR'::text,24)
  ) configured(step_no,role,due_hours)
  where configured.step_no=1
    or definition.request_type in ('TIME_OFF','OVERTIME','BUSINESS')
) step on true
where definition.version=1
on conflict(definition_id,step_no) do nothing;

-- Reading every team member is not an approval override. Only HR/Admin receive
-- the explicit break-glass capability, which also requires an MFA session and
-- a reason in review_request_commercial.
insert into public.workforce_role_capabilities(organization_id,role,capability)
select organization.id,role.name,'attendance.review.override'
from public.organizations organization
cross join(values('HR'),('Admin')) role(name)
on conflict(organization_id,role,capability) do update set enabled=true;

alter table public.attendance_requests
  add column duration_unit text not null default 'DAYS'
    check(duration_unit in ('DAYS','HALF_DAY','HOURS')),
  add column requested_minutes integer check(requested_minutes between 30 and 1440),
  add column partial_start time,
  add column partial_end time,
  add column workflow_instance_id uuid,
  add constraint attendance_requests_workflow_instance_tenant_fk
    foreign key(organization_id,workflow_instance_id)
    references public.workflow_instances(organization_id,id)
    on delete set null (workflow_instance_id);

create or replace function wf_private.request_workflow_family(p_request_type text)
returns text language sql immutable set search_path=''
as $$
  select case
    when p_request_type in ('EXPLANATION','CORRECTION') then 'ATTENDANCE'
    when p_request_type in ('ANNUAL_LEAVE','SICK_LEAVE','UNPAID_LEAVE') then 'TIME_OFF'
    when p_request_type='OVERTIME' then 'OVERTIME'
    when p_request_type='SHIFT_SWAP' then 'SHIFT_SWAP'
    else 'BUSINESS'
  end
$$;
revoke all on function wf_private.request_workflow_family(text)
from public,anon,authenticated,service_role;

create or replace function wf_private.start_request_workflow()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
declare
  definition public.workflow_definitions%rowtype;
  instance public.workflow_instances%rowtype;
  definition_step public.workflow_definition_steps%rowtype;
  assignee public.employees%rowtype;
  first_assignee_id text;
begin
  select * into definition from public.workflow_definitions candidate
  where candidate.organization_id=new.organization_id
    and candidate.request_type=wf_private.request_workflow_family(new.request_type)
    and candidate.active
  order by candidate.version desc limit 1;
  if definition.id is null then return new; end if;
  insert into public.workflow_instances(
    organization_id,definition_id,definition_version,request_id
  ) values(new.organization_id,definition.id,definition.version,new.id)
  returning * into instance;
  for definition_step in
    select * from public.workflow_definition_steps candidate
    where candidate.definition_id=definition.id order by candidate.step_no
  loop
    assignee:=null;
    if definition_step.step_no=1 and new.assigned_to is not null then
      select * into assignee from public.employees employee
      where employee.organization_id=new.organization_id
        and employee.employee_id=new.assigned_to
        and employee.status='Active'
        and employee.auth_user_id is not null
        and wf_private.employee_capable(
          new.organization_id,employee.employee_id,definition_step.capability
        )
        and wf_private.employee_approval_eligible(
          new.organization_id,employee.employee_id,new.request_type,new.employee_id
        );
    end if;
    if assignee.internal_id is null then
      select * into assignee from public.employees employee
      where employee.organization_id=new.organization_id
        and employee.role=definition_step.role
        and employee.status='Active'
        and employee.auth_user_id is not null
        and employee.employee_id<>new.employee_id
        and wf_private.employee_capable(
          new.organization_id,employee.employee_id,definition_step.capability
        )
        and wf_private.employee_approval_eligible(
          new.organization_id,employee.employee_id,new.request_type,new.employee_id
        )
      order by employee.employee_id limit 1;
    end if;
    if definition_step.step_no=1 then
      first_assignee_id:=assignee.employee_id;
    end if;
    if assignee.internal_id is null then
      raise exception 'Chưa cấu hình người duyệt hợp lệ cho bước % (%).',
        definition_step.step_no,definition_step.role
        using errcode='23514';
    end if;
    insert into public.workflow_steps(
      organization_id,instance_id,step_no,role,capability,due_hours,
      assigned_employee_internal_id,status,due_at,activated_at
    ) values(
      new.organization_id,instance.id,definition_step.step_no,
      definition_step.role,definition_step.capability,definition_step.due_hours,assignee.internal_id,
      case when definition_step.step_no=1 then 'ACTIVE' else 'PENDING' end,
      case when definition_step.step_no=1
        then clock_timestamp()+make_interval(hours=>definition_step.due_hours)
      end,
      case when definition_step.step_no=1 then clock_timestamp() end
    );
  end loop;
  update public.attendance_requests
  set workflow_instance_id=instance.id,
      assigned_to=first_assignee_id
  where id=new.id;
  perform wf_private.notify(
    first_assignee_id,'request:'||new.id::text,'REQUEST_PENDING',
    'Có yêu cầu cần duyệt',
    new.from_date::text,
    jsonb_build_object('request_id',new.id,'workflow_instance_id',instance.id)
  );
  return new;
end;
$$;
revoke all on function wf_private.start_request_workflow()
from public,anon,authenticated,service_role;
create trigger attendance_requests_start_workflow
after insert on public.attendance_requests
for each row execute function wf_private.start_request_workflow();

-- Backfill pending workflows deterministically without changing request state.
insert into public.workflow_instances(
  organization_id,definition_id,definition_version,request_id,state,current_step
)
select request.organization_id,definition.id,definition.version,request.id,
  case request.status when 'APPROVED' then 'APPROVED' when 'REJECTED' then 'REJECTED' when 'CANCELLED' then 'CANCELLED' else 'ACTIVE' end,
  1
from public.attendance_requests request
join lateral(
  select candidate.* from public.workflow_definitions candidate
  where candidate.organization_id=request.organization_id
    and candidate.request_type=wf_private.request_workflow_family(request.request_type)
    and candidate.active
  order by candidate.version desc limit 1
) definition on true
where request.workflow_instance_id is null
on conflict(request_id) do nothing;

insert into public.workflow_steps(
  organization_id,instance_id,step_no,role,capability,due_hours,
  assigned_employee_internal_id,status,due_at,activated_at,completed_at
)
select instance.organization_id,instance.id,definition_step.step_no,
  definition_step.role,definition_step.capability,definition_step.due_hours,
  assignee.internal_id,
  case
    -- A legacy terminal request proves one final decision, not that every new
    -- multi-level step was independently approved/rejected.
    when instance.state='APPROVED' and definition_step.step_no=1 then 'APPROVED'
    when instance.state='REJECTED' and definition_step.step_no=1 then 'REJECTED'
    when instance.state in ('APPROVED','REJECTED','CANCELLED') then 'SKIPPED'
    when definition_step.step_no=1 then 'ACTIVE'
    else 'PENDING'
  end,
  case when definition_step.step_no=1 then request.due_at end,
  case when definition_step.step_no=1 then instance.created_at end,
  case when instance.state<>'ACTIVE' then request.updated_at end
from public.workflow_instances instance
join public.attendance_requests request on request.id=instance.request_id
join public.workflow_definition_steps definition_step
  on definition_step.definition_id=instance.definition_id
left join lateral(
  select employee.internal_id
  from public.employees employee
  where employee.organization_id=request.organization_id
    -- Legacy requests already have a policy-selected assignee. Preserve that
    -- eligible reviewer for the first active step even when the new default
    -- workflow uses a more specific role label. This mirrors
    -- start_request_workflow() and prevents valid in-flight requests from
    -- becoming orphaned during the commercial workflow upgrade.
    and (
      employee.role=definition_step.role
      or (
        definition_step.step_no=1
        and employee.employee_id=request.assigned_to
      )
    )
    and employee.status='Active'
    and employee.auth_user_id is not null
    and employee.employee_id<>request.employee_id
    and wf_private.employee_capable(
      request.organization_id,employee.employee_id,definition_step.capability
    )
    and wf_private.employee_approval_eligible(
      request.organization_id,employee.employee_id,
      request.request_type,request.employee_id
    )
  order by
    case when definition_step.step_no=1
      and employee.employee_id=request.assigned_to then 0 else 1 end,
    employee.employee_id
  limit 1
) assignee on true
on conflict(instance_id,step_no) do nothing;

do $migration$
begin
  if exists(
    select 1
    from public.workflow_instances instance
    join public.workflow_steps step on step.instance_id=instance.id
    where instance.state='ACTIVE'
      and step.status in ('ACTIVE','PENDING')
      and step.assigned_employee_internal_id is null
  ) then
    raise exception 'Không thể nâng cấp workflow: có bước đang mở chưa có người duyệt hợp lệ.'
      using errcode='23514';
  end if;
end;
$migration$;

update public.attendance_requests request
set workflow_instance_id=instance.id
from public.workflow_instances instance
where instance.request_id=request.id
  and request.workflow_instance_id is null;

create table public.workforce_overtime_ledger(
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  employee_internal_id uuid not null,
  request_id uuid not null unique,
  start_at timestamptz not null,
  end_at timestamptz not null,
  minutes integer not null check(minutes between 1 and 720),
  payroll_state text not null default 'APPROVED' check(payroll_state in ('APPROVED','EXPORTED','VOID')),
  created_at timestamptz not null default clock_timestamp(),
  constraint workforce_overtime_ledger_request_tenant_fk
    foreign key(organization_id,request_id)
    references public.attendance_requests(organization_id,id) on delete restrict,
  foreign key(organization_id,employee_internal_id)
    references public.employees(organization_id,internal_id) on delete restrict,
  check(end_at>start_at)
);
alter table public.workforce_overtime_ledger enable row level security;
revoke all on table public.workforce_overtime_ledger
from public,anon,authenticated,service_role;

-- Keep the legacy one-row-per-day projection derived from the canonical
-- multi-session model.  Request review/cancellation and maintenance both use
-- this helper so the employee history and payroll export cannot diverge.
create or replace function wf_private.refresh_timesheet_from_sessions(
  p_organization_id uuid,
  p_employee_internal_id uuid,
  p_business_date date
)
returns void
language plpgsql
security definer
set search_path=''
as $$
declare
  employee public.employees%rowtype;
  aggregate_status text;
begin
  select * into employee
  from public.employees candidate
  where candidate.organization_id=p_organization_id
    and candidate.internal_id=p_employee_internal_id;
  if employee.internal_id is null then
    raise exception 'Không tìm thấy nhân sự để tổng hợp bảng công.' using errcode='22023';
  end if;
  if not exists(
    select 1 from public.work_sessions candidate
    where candidate.organization_id=p_organization_id
      and candidate.employee_internal_id=p_employee_internal_id
      and candidate.business_date=p_business_date
      and candidate.status<>'CANCELLED'
  ) then
    return;
  end if;

  select case
    when bool_or(candidate.status in ('NEEDS_REVIEW','PENDING_REVIEW','REJECTED')) then 'EXCEPTION'
    when bool_or(candidate.status='OPEN') then 'OPEN'
    when bool_and(candidate.status='AUTO_APPROVED') then 'AUTO_APPROVED'
    when bool_and(candidate.status='APPROVED') then 'APPROVED'
    else 'COMPLETE'
  end into aggregate_status
  from public.work_sessions candidate
  where candidate.organization_id=p_organization_id
    and candidate.employee_internal_id=p_employee_internal_id
    and candidate.business_date=p_business_date
    and candidate.status<>'CANCELLED';

  insert into public.timesheets(
    employee_id,work_date,policy_id,location_id,expected_start,expected_end,
    actual_checkin,actual_checkout,status,source,exception_codes,late_minutes,
    early_minutes,work_minutes,break_minutes
  )
  select
    employee.employee_id,p_business_date,
    (array_agg(session.policy_id order by session.session_sequence))[1],
    (array_agg(session.location_id order by session.session_sequence))[1],
    min(session.expected_start),max(session.expected_end),min(session.actual_checkin),
    case when bool_or(session.status='OPEN') then null else max(session.actual_checkout) end,
    aggregate_status,
    case when bool_or(session.source='ADJUSTED') then 'ADJUSTED' else 'NORMAL' end,
    coalesce(array(
      select distinct code
      from public.work_sessions source_session,
           unnest(source_session.exception_codes) code
      where source_session.organization_id=p_organization_id
        and source_session.employee_internal_id=p_employee_internal_id
        and source_session.business_date=p_business_date
        and source_session.status<>'CANCELLED'
      order by code
    ),'{}'),
    sum(session.late_minutes)::integer,sum(session.early_minutes)::integer,
    sum(session.work_minutes)::integer,sum(session.break_minutes)::integer
  from public.work_sessions session
  where session.organization_id=p_organization_id
    and session.employee_internal_id=p_employee_internal_id
    and session.business_date=p_business_date
    and session.status<>'CANCELLED'
  on conflict(employee_id,work_date) do update
  set policy_id=excluded.policy_id,location_id=excluded.location_id,
      expected_start=excluded.expected_start,expected_end=excluded.expected_end,
      actual_checkin=excluded.actual_checkin,actual_checkout=excluded.actual_checkout,
      status=excluded.status,source=excluded.source,
      exception_codes=excluded.exception_codes,late_minutes=excluded.late_minutes,
      early_minutes=excluded.early_minutes,work_minutes=excluded.work_minutes,
      break_minutes=excluded.break_minutes
  where public.timesheets.status<>'LOCKED';
end;
$$;
revoke all on function wf_private.refresh_timesheet_from_sessions(uuid,uuid,date)
from public,anon,authenticated,service_role;

create or replace function wf_private.submit_request_commercial(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  actor public.employees%rowtype;
  policy public.attendance_policies%rowtype;
  result jsonb;
  request_id uuid;
  request public.attendance_requests%rowtype;
  session public.work_sessions%rowtype;
  legacy_sheet public.timesheets%rowtype;
  requested_duration_unit text:=upper(coalesce(p->>'duration_unit','DAYS'));
  requested_duration_minutes integer;
  maximum_minutes integer;
  requested_partial_start time:=nullif(p->>'partial_start','')::time;
  requested_partial_end time:=nullif(p->>'partial_end','')::time;
  client_request_uuid uuid;
  first_day date:=(p->>'from_date')::date;
  last_day date:=coalesce((p->>'to_date')::date,(p->>'from_date')::date);
  kind text:=p->>'request_type';
  why text:=trim(coalesce(p->>'reason',''));
  owner_id text;
  backup_id text;
  today date;
begin
  actor:=wf_private.require_capability('request.submit');
  today:=wf_private.organization_local_date(actor.organization_id,clock_timestamp());
  begin
    client_request_uuid:=nullif(trim(coalesce(p->>'client_request_id','')),'')::uuid;
  exception when others then
    raise exception 'Mã gửi yêu cầu không hợp lệ.' using errcode='22023';
  end;
  if kind not in (
    'EXPLANATION','CORRECTION','ANNUAL_LEAVE','SICK_LEAVE','UNPAID_LEAVE',
    'BUSINESS_TRIP','REMOTE_WORK','SHIFT_SWAP','OVERTIME'
  ) or length(why) not between 5 and 1000 then
    raise exception 'Chọn loại yêu cầu và nhập lý do từ 5 đến 1.000 ký tự.';
  end if;
  if first_day is null or last_day<first_day or last_day-first_day>366
    or first_day<today-45 or last_day>today+366 then
    raise exception 'Khoảng ngày không hợp lệ.' using errcode='22023';
  end if;
  select * into policy from public.attendance_policies
  where id=actor.attendance_policy_id and organization_id=actor.organization_id;
  if requested_duration_unit<>'DAYS' and policy.id is null then
    raise exception 'Chưa có chính sách chấm công hợp lệ.' using errcode='22023';
  end if;
  if requested_duration_unit not in ('DAYS','HALF_DAY','HOURS') then
    raise exception 'Đơn vị thời lượng không hợp lệ.' using errcode='22023';
  end if;
  maximum_minutes:=greatest(30,
    floor(extract(epoch from(
      (date '2000-01-02'+policy.expected_end
        +case when policy.expected_end<=policy.expected_start then interval '1 day' else interval '0 days' end)
      -(date '2000-01-02'+policy.expected_start)
    ))/60)::integer-policy.unpaid_break_minutes
  );
  if requested_duration_unit='HALF_DAY' then
    requested_duration_minutes:=coalesce((p->>'requested_minutes')::integer,greatest(30,maximum_minutes/2));
  elsif requested_duration_unit='HOURS' then
    requested_duration_minutes:=(p->>'requested_minutes')::integer;
  end if;
  if requested_duration_unit<>'DAYS' and (
    requested_duration_minutes is null
    or requested_duration_minutes not between 30 and maximum_minutes
  ) then
    raise exception 'Số phút nghỉ phải từ 30 đến % phút.',maximum_minutes using errcode='22023';
  end if;
  if requested_duration_unit<>'DAYS' and (p->>'from_date')::date<>(p->>'to_date')::date then
    raise exception 'Nghỉ nửa ngày/theo giờ chỉ áp dụng trong một ngày.' using errcode='22023';
  end if;
  if requested_duration_unit<>'DAYS' and (
    requested_partial_start is null
    or requested_partial_end is null
    or requested_partial_end<=requested_partial_start
    or extract(epoch from(requested_partial_end-requested_partial_start))/60
      <>requested_duration_minutes
  ) then
    raise exception 'Khung giờ nghỉ phải hợp lệ và khớp chính xác số phút đề nghị.' using errcode='22023';
  end if;

  if requested_duration_unit<>'DAYS' then
    if kind not in ('ANNUAL_LEAVE','SICK_LEAVE','UNPAID_LEAVE') then
      raise exception 'Nghỉ nửa ngày/theo giờ chỉ áp dụng cho đơn nghỉ.' using errcode='22023';
    end if;
    if client_request_uuid is null then
      raise exception 'Thiếu mã gửi yêu cầu để chống tạo đơn trùng.' using errcode='22023';
    end if;
    perform pg_advisory_xact_lock(hashtextextended(
      'request-submit:'||actor.organization_id::text||':'||actor.employee_id,0
    ));
    select * into request from public.attendance_requests existing_request
    where existing_request.organization_id=actor.organization_id
      and existing_request.employee_id=actor.employee_id
      and existing_request.client_request_id=client_request_uuid;
    if request.id is not null then
      if (
        request.request_type,request.from_date,request.to_date,request.reason,
        request.duration_unit,request.requested_minutes,
        request.partial_start,request.partial_end
      ) is distinct from (
        kind,first_day,last_day,why,requested_duration_unit,
        requested_duration_minutes,requested_partial_start,requested_partial_end
      ) then
        raise exception 'Mã gửi yêu cầu đã được dùng cho nội dung khác.' using errcode='22023';
      end if;
      return jsonb_build_object(
        'ok',true,'request',to_jsonb(request),'replayed',true
      );
    end if;
    perform wf_private.period_lock(
      actor.organization_id,first_day,last_day,false
    );
    if exists(
      select 1 from public.attendance_periods period
      where period.organization_id=actor.organization_id
        and period.status='CLOSED'
        and first_day between period.period_start and period.period_end
    ) then raise exception 'Yêu cầu liên quan kỳ công đã khóa.'; end if;
    if exists(
      select 1 from public.attendance_requests existing_request
      where existing_request.organization_id=actor.organization_id
        and existing_request.employee_id=actor.employee_id
        and existing_request.status in ('PENDING','APPROVED')
        and existing_request.request_type in (
          'ANNUAL_LEAVE','SICK_LEAVE','UNPAID_LEAVE'
        )
        and first_day between existing_request.from_date and existing_request.to_date
        and (
          existing_request.duration_unit='DAYS'
          or (
            existing_request.from_date=first_day
            and existing_request.to_date=first_day
            and existing_request.partial_start<requested_partial_end
            and existing_request.partial_end>requested_partial_start
          )
        )
    ) then
      raise exception 'Khung giờ nghỉ trùng với yêu cầu đang chờ hoặc đã duyệt.';
    end if;
    select employee.employee_id into owner_id
    from public.employees employee
    where employee.organization_id=actor.organization_id
      and employee.employee_id=actor.direct_manager_id
      and wf_private.employee_approval_eligible(
        actor.organization_id,employee.employee_id,kind,actor.employee_id
      );
    select employee.employee_id into backup_id
    from public.employees employee
    where employee.organization_id=actor.organization_id
      and employee.role in ('HR','Admin')
      and employee.employee_id is distinct from owner_id
      and wf_private.employee_approval_eligible(
        actor.organization_id,employee.employee_id,kind,actor.employee_id
      )
    order by case when employee.role='HR' then 0 else 1 end,employee.employee_id
    limit 1;
    owner_id:=coalesce(owner_id,backup_id);
    if owner_id is null then
      raise exception 'Chưa cấu hình người duyệt hợp lệ.' using errcode='23514';
    end if;
    insert into public.attendance_requests(
      organization_id,employee_id,request_type,reason,status,from_date,to_date,
      assigned_to,fallback_to,workflow_data,client_request_id,duration_unit,
      requested_minutes,partial_start,partial_end
    ) values(
      actor.organization_id,actor.employee_id,kind,why,'PENDING',first_day,last_day,
      owner_id,backup_id,'{}',client_request_uuid,requested_duration_unit,
      requested_duration_minutes,requested_partial_start,requested_partial_end
    ) returning id into request_id;
    select * into request from public.attendance_requests current_request
    where current_request.id=request_id
      and current_request.organization_id=actor.organization_id;
    perform wf_private.audit(
      'REQUEST_SUBMITTED','attendance_request',request.id::text,why,
      jsonb_build_object(
        'type',kind,'assigned_to',request.assigned_to,
        'duration_unit',requested_duration_unit,
        'requested_minutes',requested_duration_minutes
      )
    );
    return jsonb_build_object('ok',true,'request',to_jsonb(request));
  end if;

  result:=wf_private.submit_request(p);
  request_id:=(result->'request'->>'id')::uuid;
  select * into request from public.attendance_requests current_request
  where current_request.id=request_id
    and current_request.organization_id=actor.organization_id
  for update;
  if coalesce((result->>'replayed')::boolean,false) and (
    request.duration_unit,
    request.requested_minutes,
    request.partial_start,
    request.partial_end
  ) is distinct from (
    requested_duration_unit,
    requested_duration_minutes,
    requested_partial_start,
    requested_partial_end
  ) then
    raise exception 'Mã gửi yêu cầu đã được dùng cho thời lượng khác.' using errcode='22023';
  end if;
  if coalesce((result->>'replayed')::boolean,false) then
    -- Binding an explanation twice would overwrite the original restoration
    -- status with PENDING_REVIEW. A valid replay is a pure read of its receipt.
    return result||jsonb_build_object('request',to_jsonb(request));
  end if;
  update public.attendance_requests current_request
  set duration_unit=requested_duration_unit,
      requested_minutes=requested_duration_minutes,
      partial_start=requested_partial_start,
      partial_end=requested_partial_end
  where current_request.id=request_id
    and current_request.organization_id=actor.organization_id
    and (
      current_request.duration_unit,
      current_request.requested_minutes,
      current_request.partial_start,
      current_request.partial_end
    ) is distinct from (
      requested_duration_unit,
      requested_duration_minutes,
      requested_partial_start,
      requested_partial_end
    )
  returning * into request;
  if request.id is null then
    select * into request from public.attendance_requests current_request
    where current_request.id=request_id
      and current_request.organization_id=actor.organization_id;
  end if;

  if request.request_type in ('EXPLANATION','CORRECTION') then
    if nullif(p->>'work_session_id','') is not null then
      select * into session from public.work_sessions candidate
      where candidate.id=(p->>'work_session_id')::uuid
        and candidate.organization_id=actor.organization_id
        and candidate.employee_internal_id=actor.internal_id
        and candidate.business_date=request.from_date
      for update;
    else
      select * into session from public.work_sessions candidate
      where candidate.organization_id=actor.organization_id
        and candidate.employee_internal_id=actor.internal_id
        and candidate.business_date=request.from_date
        and candidate.status<>'CANCELLED'
      order by
        (candidate.status in ('NEEDS_REVIEW','REJECTED')) desc,
        candidate.session_sequence desc
      limit 1 for update;
    end if;

    -- The compatibility submitter can create a missing-day timesheet for a
    -- forgotten check-in/check-out. Materialize its canonical v4 session in
    -- the same transaction so the commercial workflow can bind and review it
    -- instead of rejecting a legitimate correction.
    if session.id is null then
      select * into legacy_sheet
      from public.timesheets candidate
      where candidate.organization_id=actor.organization_id
        and candidate.employee_id=actor.employee_id
        and candidate.work_date=request.from_date
      for update;
      if legacy_sheet.id is not null and legacy_sheet.status<>'LOCKED' then
        insert into public.work_sessions(
          id,organization_id,employee_internal_id,employee_id,
          business_date,session_sequence,policy_id,
          location_internal_id,location_id,expected_start,expected_end,
          actual_checkin,actual_checkout,status,source,exception_codes,
          break_started_at,break_minutes,late_minutes,early_minutes,
          work_minutes,revision,locked_at,locked_by,created_at,updated_at
        )
        select
          legacy_sheet.id,actor.organization_id,actor.internal_id,actor.employee_id,
          legacy_sheet.work_date,1,legacy_sheet.policy_id,
          location.internal_id,
          case when location.internal_id is null then null else legacy_sheet.location_id end,
          legacy_sheet.expected_start,legacy_sheet.expected_end,
          legacy_sheet.actual_checkin,legacy_sheet.actual_checkout,
          case coalesce(request.workflow_data->>'previous_status',legacy_sheet.status)
            when 'EXCEPTION' then 'NEEDS_REVIEW'
            when 'SCHEDULED' then 'SCHEDULED'
            when 'OPEN' then 'OPEN'
            when 'COMPLETE' then 'COMPLETE'
            when 'AUTO_APPROVED' then 'AUTO_APPROVED'
            when 'APPROVED' then 'APPROVED'
            when 'REJECTED' then 'REJECTED'
            when 'LOCKED' then 'LOCKED'
            when 'CANCELLED' then 'CANCELLED'
            else 'PENDING_REVIEW'
          end,
          case legacy_sheet.source
            when 'ADJUSTED' then 'ADJUSTED'
            when 'LEGACY' then 'LEGACY'
            else 'NORMAL'
          end,
          legacy_sheet.exception_codes,legacy_sheet.break_started_at,
          legacy_sheet.break_minutes,legacy_sheet.late_minutes,
          legacy_sheet.early_minutes,legacy_sheet.work_minutes,
          legacy_sheet.revision,legacy_sheet.locked_at,legacy_sheet.locked_by,
          legacy_sheet.created_at,legacy_sheet.updated_at
        from (select 1) seed
        left join public.locations location
          on location.organization_id=actor.organization_id
         and location.center_id=legacy_sheet.location_id
        on conflict(id) do nothing
        returning * into session;
        if session.id is null then
          select * into session from public.work_sessions candidate
          where candidate.id=legacy_sheet.id
            and candidate.organization_id=actor.organization_id
            and candidate.employee_internal_id=actor.internal_id
            and candidate.status<>'CANCELLED'
          for update;
        end if;
      end if;
    end if;
    if session.id is null or session.status='LOCKED' then
      raise exception 'Không tìm thấy ca có thể giải trình trong ngày này.' using errcode='22023';
    end if;
    update public.attendance_requests
    set work_session_id=session.id,
        workflow_data=workflow_data||jsonb_build_object(
          'previous_session_status',session.status,
          'work_session_sequence',session.session_sequence
        )
    where id=request.id returning * into request;
    update public.work_sessions
    set status='PENDING_REVIEW'
    where id=session.id and status<>'PENDING_REVIEW';
  end if;
  return result||jsonb_build_object('request',to_jsonb(request));
end;
$$;
revoke all on function wf_private.submit_request_commercial(jsonb)
from public,anon,authenticated,service_role;

create or replace function wf_private.review_request_commercial(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  actor public.employees%rowtype;
  request public.attendance_requests%rowtype;
  instance public.workflow_instances%rowtype;
  active_step public.workflow_steps%rowtype;
  next_step public.workflow_steps%rowtype;
  assigned public.employees%rowtype;
  delegation public.workflow_delegations%rowtype;
  result jsonb;
  decision text:=upper(coalesce(p->>'decision',''));
  review_reason text:=trim(coalesce(p->>'note',''));
  adjusted_days numeric;
  standard_minutes integer;
  request_employee public.employees%rowtype;
  request_session public.work_sessions%rowtype;
  request_policy public.attendance_policies%rowtype;
  start_at timestamptz;
  end_at timestamptz;
  unpaid_minutes integer:=0;
  restored_status text;
  corrected_late_minutes integer:=0;
  corrected_early_minutes integer:=0;
  corrected_codes text[]:='{}'::text[];
begin
  actor:=wf_private.require_capability('attendance.review');
  if decision not in ('APPROVED','REJECTED') then raise exception 'Quyết định không hợp lệ.'; end if;
  select * into request from public.attendance_requests candidate
  where candidate.id=(p->>'id')::uuid
    and candidate.organization_id=actor.organization_id;
  if request.id is null or request.status<>'PENDING'
    or request.revision<>coalesce((p->>'revision')::bigint,0) then
    raise exception 'Yêu cầu đã thay đổi. Tải lại.' using errcode='40001';
  end if;
  perform wf_private.period_lock(
    actor.organization_id,request.from_date,request.to_date,false
  );
  if exists(
    select 1 from public.attendance_periods period
    where period.organization_id=actor.organization_id
      and period.status='CLOSED'
      and daterange(period.period_start,period.period_end,'[]')
          && daterange(request.from_date,request.to_date,'[]')
  ) then raise exception 'Kỳ công đã khóa.'; end if;
  select * into request from public.attendance_requests candidate
  where candidate.id=request.id
    and candidate.organization_id=actor.organization_id
  for update;
  if request.status<>'PENDING'
    or request.revision<>coalesce((p->>'revision')::bigint,0) then
    raise exception 'Yêu cầu đã thay đổi. Tải lại.' using errcode='40001';
  end if;
  if request.employee_id=actor.employee_id then
    raise exception 'Không được tự duyệt yêu cầu của mình.' using errcode='42501';
  end if;
  select * into instance from public.workflow_instances candidate
  where candidate.request_id=request.id for update;
  if instance.id is null then return wf_private.review_request(p); end if;
  select * into active_step from public.workflow_steps candidate
  where candidate.instance_id=instance.id and candidate.status='ACTIVE'
  order by candidate.step_no limit 1 for update;
  if active_step.id is null then raise exception 'Workflow không có bước đang xử lý.'; end if;
  select * into assigned from public.employees employee
  where employee.organization_id=actor.organization_id
    and employee.internal_id=active_step.assigned_employee_internal_id;
  select * into delegation from public.workflow_delegations candidate
  where candidate.organization_id=actor.organization_id
    and candidate.from_employee_internal_id=active_step.assigned_employee_internal_id
    and candidate.to_employee_internal_id=actor.internal_id
    and candidate.revoked_at is null
    and clock_timestamp()>=candidate.starts_at and clock_timestamp()<candidate.ends_at
    and (cardinality(candidate.request_types)=0 or request.request_type=any(candidate.request_types))
  order by candidate.created_at desc limit 1;
  if actor.internal_id is distinct from active_step.assigned_employee_internal_id
    and delegation.id is null
    and not(wf_private.capable('attendance.review.override') and length(review_reason)>=5) then
    raise exception 'Bạn không phải người xử lý bước hiện tại.' using errcode='42501';
  end if;
  if actor.internal_id is distinct from active_step.assigned_employee_internal_id
    and delegation.id is null then
    if coalesce((select auth.jwt()->>'aal'),'aal1')<>'aal2' then
      raise exception 'Duyệt thay người khác yêu cầu xác thực hai lớp.'
        using errcode='42501';
    end if;
    perform wf_private.audit(
      'WORKFLOW_REVIEW_OVERRIDE','workflow_step',active_step.id::text,review_reason,
      jsonb_build_object('request_id',request.id,'assigned_to',assigned.employee_id)
    );
  end if;
  if decision='REJECTED' and length(review_reason)<5 then
    raise exception 'Từ chối phải có lý do ít nhất 5 ký tự.';
  end if;

  insert into public.workflow_decisions(
    organization_id,instance_id,step_id,actor_employee_internal_id,
    delegated_from_internal_id,decision,reason,context
  ) values(
    actor.organization_id,instance.id,active_step.id,actor.internal_id,
    case when delegation.id is null then null else active_step.assigned_employee_internal_id end,
    decision,review_reason,jsonb_build_object('request_revision',request.revision)
  );
  update public.workflow_steps
  set status=decision,completed_at=clock_timestamp()
  where id=active_step.id;

  if decision='APPROVED' then
    select * into next_step from public.workflow_steps candidate
    where candidate.instance_id=instance.id
      and candidate.step_no>active_step.step_no
      and candidate.status='PENDING'
    order by candidate.step_no limit 1 for update;
  end if;
  if next_step.id is not null then
    select * into assigned from public.employees employee
    where employee.organization_id=actor.organization_id
      and employee.internal_id=next_step.assigned_employee_internal_id
      and employee.status='Active'
      and employee.auth_user_id is not null
      and wf_private.employee_capable(
        actor.organization_id,employee.employee_id,next_step.capability
      )
      and wf_private.employee_approval_eligible(
        actor.organization_id,employee.employee_id,
        request.request_type,request.employee_id
      );
    if assigned.internal_id is null then
      select * into assigned from public.employees employee
      where employee.organization_id=actor.organization_id
        and employee.role=next_step.role
        and employee.status='Active'
        and employee.auth_user_id is not null
        and employee.employee_id<>request.employee_id
        and wf_private.employee_capable(
          actor.organization_id,employee.employee_id,next_step.capability
        )
        and wf_private.employee_approval_eligible(
          actor.organization_id,employee.employee_id,
          request.request_type,request.employee_id
        )
      order by employee.employee_id
      limit 1;
    end if;
    if assigned.internal_id is null then
      raise exception 'Bước duyệt tiếp theo chưa có người xử lý hợp lệ.'
        using errcode='23514';
    end if;
    update public.workflow_steps
    set assigned_employee_internal_id=assigned.internal_id,
        status='ACTIVE',activated_at=clock_timestamp(),
        due_at=clock_timestamp()+make_interval(hours=>due_hours)
    where id=next_step.id;
    select * into next_step from public.workflow_steps candidate
    where candidate.id=next_step.id;
    update public.workflow_instances set current_step=next_step.step_no where id=instance.id;
    update public.attendance_requests
    set assigned_to=assigned.employee_id,due_at=next_step.due_at
    where id=request.id returning * into request;
    perform wf_private.notify(
      assigned.employee_id,'workflow-step:'||next_step.id::text,'REQUEST_PENDING',
      'Có yêu cầu chờ duyệt bước '||next_step.step_no::text,
      request.request_code,jsonb_build_object('request_id',request.id,'step',next_step.step_no)
    );
    return jsonb_build_object('ok',true,'completed',false,'next_step',next_step.step_no,'revision',request.revision);
  end if;

  -- Reassign only inside this transaction when acting by delegation.
  if request.assigned_to is distinct from actor.employee_id then
    update public.attendance_requests set assigned_to=actor.employee_id
    where id=request.id returning * into request;
  end if;

  -- Explanation/correction is session-native.  Calling the legacy writer here
  -- would update only the daily compatibility row and would also validate
  -- dates in a fixed timezone.  Apply the effect to the canonical session,
  -- then rebuild the daily projection from all sessions.
  if request.request_type in ('EXPLANATION','CORRECTION') then
    if exists(
      select 1 from public.attendance_periods period
      where period.organization_id=actor.organization_id
        and period.status='CLOSED'
        and request.from_date between period.period_start and period.period_end
    ) then
      raise exception 'Kỳ công đã khóa.';
    end if;
    select * into request_employee from public.employees employee
    where employee.organization_id=actor.organization_id
      and employee.employee_id=request.employee_id
    for update;
    select * into request_session from public.work_sessions session
    where session.organization_id=actor.organization_id
      and session.id=request.work_session_id
      and session.employee_internal_id=request_employee.internal_id
    for update;
    if request_session.id is null or request_session.status='LOCKED' then
      raise exception 'Ca cần giải trình không còn khả dụng.' using errcode='22023';
    end if;
    select * into request_policy from public.attendance_policies policy
    where policy.organization_id=actor.organization_id
      and policy.id=coalesce(request_session.policy_id,request_employee.attendance_policy_id);

    if decision='APPROVED' then
      start_at:=coalesce(request.requested_checkin,request_session.actual_checkin);
      end_at:=coalesce(request.requested_checkout,request_session.actual_checkout);
      if start_at is null or end_at is null or end_at<=start_at
        or end_at-start_at>interval '24 hours'
        or wf_private.organization_local_date(actor.organization_id,start_at)
             <>request_session.business_date
        or end_at>clock_timestamp() then
        raise exception 'Thiếu giờ thực tế hợp lệ. Cần yêu cầu điều chỉnh, không tự quy đủ công từ giải trình.';
      end if;
      unpaid_minutes:=greatest(
        request_session.break_minutes,
        case when end_at-start_at>=interval '6 hours'
          then coalesce(request_policy.unpaid_break_minutes,0) else 0 end
      );
      corrected_late_minutes:=case
        when request_session.expected_start is not null
          and start_at>request_session.expected_start+make_interval(
            mins=>coalesce(request_policy.late_tolerance_minutes,0)
          )
        then greatest(0,floor(extract(epoch from(
          start_at-request_session.expected_start
        ))/60)::integer)
        else 0
      end;
      corrected_early_minutes:=case
        when request_session.expected_end is not null
          and end_at<request_session.expected_end-make_interval(
            mins=>coalesce(request_policy.early_tolerance_minutes,0)
          )
        then greatest(0,floor(extract(epoch from(
          request_session.expected_end-end_at
        ))/60)::integer)
        else 0
      end;
      corrected_codes:=array_remove(array_remove(array_remove(array_remove(
        coalesce(request_session.exception_codes,'{}'),
        'MISSING_CHECKIN'),'MISSING_CHECKOUT'),'LATE'),'EARLY_LEAVE');
      if corrected_late_minutes>0 then
        corrected_codes:=array_append(corrected_codes,'LATE');
      end if;
      if corrected_early_minutes>0 then
        corrected_codes:=array_append(corrected_codes,'EARLY_LEAVE');
      end if;
      perform wf_private.audit(
        'WORK_SESSION_BEFORE_CORRECTION','work_session',request_session.id::text,
        review_reason,to_jsonb(request_session)
      );
      update public.work_sessions
      set actual_checkin=start_at,
          actual_checkout=end_at,
          source=case when request.request_type='CORRECTION' then 'ADJUSTED' else source end,
          work_minutes=greatest(
            0,floor(extract(epoch from(end_at-start_at))/60)::integer-unpaid_minutes
          ),
          break_minutes=unpaid_minutes,
          late_minutes=corrected_late_minutes,
          early_minutes=corrected_early_minutes,
          break_started_at=null,
          exception_codes=corrected_codes,
          status='APPROVED'
      where id=request_session.id
      returning * into request_session;
      if request.request_type='CORRECTION' then
        insert into public.attendance_events(
          timesheet_id,work_session_id,employee_id,event_type,work_date,
          location_id,outcome,validation
        ) values(
          request.timesheet_id,request_session.id,request_employee.employee_id,
          'CORRECTION',request_session.business_date,request_session.location_id,
          'VALID',jsonb_build_object(
            'request_id',request.id,'approver',actor.employee_id,
            'requested_checkin',start_at,'requested_checkout',end_at
          )
        );
      end if;
    else
      restored_status:=coalesce(
        nullif(request.workflow_data->>'previous_session_status',''),
        'NEEDS_REVIEW'
      );
      if restored_status not in (
        'SCHEDULED','OPEN','COMPLETE','AUTO_APPROVED','NEEDS_REVIEW',
        'APPROVED','REJECTED','CANCELLED'
      ) then
        restored_status:='NEEDS_REVIEW';
      end if;
      update public.work_sessions
      set status=restored_status
      where id=request_session.id and status='PENDING_REVIEW'
      returning * into request_session;
    end if;
    perform wf_private.refresh_timesheet_from_sessions(
      actor.organization_id,request_employee.internal_id,request_session.business_date
    );
    update public.attendance_requests
    set status=decision,manager_note=review_reason,approver_id=actor.employee_id
    where id=request.id returning * into request;
    perform wf_private.notify(
      request.employee_id,'decision:'||request.id::text,'REQUEST_DECIDED',
      case when decision='APPROVED' then 'Yêu cầu đã được duyệt' else 'Yêu cầu bị từ chối' end,
      coalesce(nullif(review_reason,''),'Mở trung tâm yêu cầu để xem chi tiết.'),
      jsonb_build_object('request_id',request.id,'work_session_id',request_session.id)
    );
    perform wf_private.audit(
      'REQUEST_'||decision,'attendance_request',request.id::text,review_reason,
      jsonb_build_object(
        'employee_id',request.employee_id,'type',request.request_type,
        'work_session_id',request_session.id
      )
    );
    result:=jsonb_build_object('ok',true);
  elsif request.request_type in ('ANNUAL_LEAVE','SICK_LEAVE','UNPAID_LEAVE')
    and request.duration_unit<>'DAYS' then
    select * into request_employee from public.employees employee
    where employee.organization_id=actor.organization_id
      and employee.employee_id=request.employee_id
    for update;
    select * into request_policy from public.attendance_policies policy
    where policy.organization_id=actor.organization_id
      and policy.id=request_employee.attendance_policy_id;
    if request_employee.internal_id is null or request_policy.id is null then
      raise exception 'Không tìm thấy nhân sự hoặc chính sách nghỉ phép.' using errcode='22023';
    end if;
    if decision='APPROVED' then
      if not(
        extract(isodow from request.from_date)::smallint=any(request_policy.work_days)
        or exists(
          select 1 from public.shift_assignments assignment
          where assignment.organization_id=actor.organization_id
            and assignment.employee_internal_id=request_employee.internal_id
            and assignment.work_date=request.from_date
            and assignment.publication_status='PUBLISHED'
        )
      ) or exists(
        select 1 from public.holidays holiday
        where holiday.organization_id=actor.organization_id
          and holiday.active
          and request.from_date between holiday.from_date and holiday.to_date
      ) then
        raise exception 'Khung nghỉ không thuộc ngày làm việc.';
      end if;
      if exists(
        select 1 from public.attendance_requests existing_request
        where existing_request.organization_id=actor.organization_id
          and existing_request.employee_id=request.employee_id
          and existing_request.id<>request.id
          and existing_request.status='APPROVED'
          and existing_request.request_type in (
            'ANNUAL_LEAVE','SICK_LEAVE','UNPAID_LEAVE'
          )
          and request.from_date between existing_request.from_date and existing_request.to_date
          and (
            existing_request.duration_unit='DAYS'
            or (
              existing_request.from_date=request.from_date
              and existing_request.to_date=request.from_date
              and existing_request.partial_start<request.partial_end
              and existing_request.partial_end>request.partial_start
            )
          )
      ) then
        raise exception 'Khung nghỉ trùng với đơn đã duyệt.';
      end if;
      standard_minutes:=greatest(30,
        floor(extract(epoch from(
          (date '2000-01-02'+request_policy.expected_end
            +case when request_policy.expected_end<=request_policy.expected_start
              then interval '1 day' else interval '0 days' end)
          -(date '2000-01-02'+request_policy.expected_start)
        ))/60)::integer-request_policy.unpaid_break_minutes
      );
      adjusted_days:=round(
        request.requested_minutes::numeric/standard_minutes::numeric,4
      );
      if request.request_type='ANNUAL_LEAVE' then
        if coalesce(request_employee.annual_leave_balance,0)<adjusted_days then
          raise exception 'Quỹ phép không đủ.';
        end if;
        insert into public.workforce_leave_ledger(
          organization_id,employee_id,request_id,days
        ) values(
          actor.organization_id,request.employee_id,request.id,adjusted_days
        );
        update public.employees
        set annual_leave_balance=annual_leave_balance-adjusted_days
        where organization_id=actor.organization_id
          and internal_id=request_employee.internal_id;
      end if;
    end if;
    update public.attendance_requests
    set status=decision,manager_note=review_reason,approver_id=actor.employee_id
    where id=request.id and organization_id=actor.organization_id
    returning * into request;
    perform wf_private.notify(
      request.employee_id,'decision:'||request.id::text,'REQUEST_DECIDED',
      case when decision='APPROVED'
        then 'Yêu cầu đã được duyệt' else 'Yêu cầu bị từ chối' end,
      coalesce(nullif(review_reason,''),'Mở trung tâm yêu cầu để xem chi tiết.'),
      jsonb_build_object('request_id',request.id)
    );
    perform wf_private.audit(
      'REQUEST_'||decision,'attendance_request',request.id::text,review_reason,
      jsonb_build_object(
        'employee_id',request.employee_id,'type',request.request_type,
        'duration_unit',request.duration_unit,
        'requested_minutes',request.requested_minutes
      )
    );
    result:=jsonb_build_object('ok',true);
  else
    -- The compatibility effect function remains the writer for leave and swap
    -- rules until those aggregates are fully retired.
    result:=wf_private.review_request(
      p||jsonb_build_object('revision',request.revision,'decision',decision)
    );
  end if;

  if decision='APPROVED' and request.request_type='OVERTIME' then
    insert into public.workforce_overtime_ledger(
      organization_id,employee_internal_id,request_id,start_at,end_at,minutes
    ) select actor.organization_id,employee.internal_id,request.id,
      request.requested_checkin,request.requested_checkout,
      floor(extract(epoch from(request.requested_checkout-request.requested_checkin))/60)::integer
    from public.employees employee
    where employee.employee_id=request.employee_id
      and employee.organization_id=actor.organization_id
    on conflict(request_id) do nothing;
  end if;
  update public.workflow_instances
  set state=decision,completed_at=clock_timestamp()
  where id=instance.id;
  return result||jsonb_build_object('workflow_completed',true);
end;
$$;
revoke all on function wf_private.review_request_commercial(jsonb)
from public,anon,authenticated,service_role;

-- ---------------------------------------------------------------------------
-- Reopenable payroll periods and versioned HRIS outbox.
-- ---------------------------------------------------------------------------
alter table public.work_sessions add column status_before_lock text;

alter table public.workforce_payroll_exports
  add constraint workforce_payroll_exports_organization_id_key
  unique(organization_id,id);

create table public.workforce_integrations(
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  kind text not null check(kind in ('HRIS','PAYROLL','SCIM','SSO')),
  name text not null check(char_length(name) between 1 and 120),
  endpoint text,
  secret_reference text,
  enabled boolean not null default false,
  config jsonb not null default '{}',
  revision bigint not null default 1,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint workforce_integrations_organization_id_key
    unique(organization_id,id),
  unique(organization_id,kind,name),
  check(endpoint is null or endpoint ~ '^https://')
);
alter table public.workforce_integrations enable row level security;
revoke all on table public.workforce_integrations
from public,anon,authenticated,service_role;

create table public.hris_export_outbox(
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  integration_id uuid,
  payroll_export_id uuid not null,
  contract_version text not null default '2026-09-01',
  payload jsonb not null,
  state text not null default 'PENDING' check(state in ('PENDING','PROCESSING','DELIVERED','FAILED','VOID')),
  attempts integer not null default 0 check(attempts between 0 and 20),
  available_at timestamptz not null default clock_timestamp(),
  lease_token uuid,
  leased_at timestamptz,
  lease_expires_at timestamptz,
  last_error_code text,
  delivered_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  unique(organization_id,payroll_export_id,integration_id),
  constraint hris_export_outbox_integration_tenant_fk
    foreign key(organization_id,integration_id)
    references public.workforce_integrations(organization_id,id) on delete restrict,
  constraint hris_export_outbox_payroll_export_tenant_fk
    foreign key(organization_id,payroll_export_id)
    references public.workforce_payroll_exports(organization_id,id) on delete restrict
);
create index hris_export_outbox_claim_idx
  on public.hris_export_outbox(state,available_at,id)
  where state in ('PENDING','FAILED','PROCESSING');
alter table public.hris_export_outbox enable row level security;
revoke all on table public.hris_export_outbox
from public,anon,authenticated,service_role;

create or replace function wf_private.payroll_reopen_commercial(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  actor public.employees%rowtype;
  first_day date:=(p->>'from')::date;
  last_day date:=(p->>'to')::date;
  reason text:=trim(coalesce(p->>'note',''));
  period public.attendance_periods%rowtype;
  restored_timesheets integer:=0;
  restored_sessions integer:=0;
begin
  actor:=wf_private.require_capability('attendance.reopen_period');
  if not wf_private.capable('team.read_all') then
    raise exception 'Cần phạm vi toàn tổ chức.' using errcode='42501';
  end if;
  if first_day is null or last_day is null or first_day>last_day or last_day-first_day>62 then
    raise exception 'Khoảng kỳ công không hợp lệ.' using errcode='22023';
  end if;
  if length(reason)<10 then raise exception 'Mở lại kỳ phải có lý do ít nhất 10 ký tự.'; end if;
  perform wf_private.period_lock(actor.organization_id,first_day,last_day,true);
  select * into period from public.attendance_periods candidate
  where candidate.organization_id=actor.organization_id
    and candidate.period_start=first_day and candidate.period_end=last_day
  for update;
  if period.id is null or period.status<>'CLOSED' then raise exception 'Kỳ công chưa đóng.'; end if;

  perform wf_private.audit(
    'PAYROLL_PERIOD_BEFORE_REOPEN','attendance_period',period.id::text,reason,
    jsonb_build_object(
      'period',to_jsonb(period),
      'timesheet_fingerprint',wf_private.fingerprint(first_day,last_day)
    )
  );
  update public.timesheets
  set status=coalesce(nullif(status_before_lock,''),'COMPLETE'),
      status_before_lock=null,locked_at=null,locked_by=null
  where organization_id=actor.organization_id
    and work_date between first_day and last_day and status='LOCKED';
  get diagnostics restored_timesheets=row_count;
  update public.work_sessions
  set status=coalesce(nullif(status_before_lock,''),'COMPLETE'),
      status_before_lock=null,locked_at=null,locked_by=null
  where organization_id=actor.organization_id
    and business_date between first_day and last_day and status='LOCKED';
  get diagnostics restored_sessions=row_count;
  update public.workforce_payroll_exports
  set invalidated_at=clock_timestamp(),invalidated_reason=reason
  where organization_id=actor.organization_id
    and period_start=first_day and period_end=last_day
    and invalidated_at is null;
  update public.hris_export_outbox outbox
  set state='VOID',last_error_code='PAYROLL_PERIOD_REOPENED'
  where outbox.organization_id=actor.organization_id
    and outbox.payroll_export_id in(
      select export.id from public.workforce_payroll_exports export
      where export.organization_id=actor.organization_id
        and export.period_start=first_day and export.period_end=last_day
    ) and outbox.state<>'DELIVERED';
  update public.attendance_periods
  set status='REOPENED',reopened_by=actor.employee_id,
      reopened_at=clock_timestamp(),reopen_reason=reason,
      updated_at=clock_timestamp()
  where id=period.id;
  perform wf_private.audit(
    'PAYROLL_PERIOD_REOPENED','attendance_period',period.id::text,reason,
    jsonb_build_object('timesheets',restored_timesheets,'sessions',restored_sessions)
  );
  return jsonb_build_object(
    'ok',true,'timesheets',restored_timesheets,'sessions',restored_sessions
  );
end;
$$;
revoke all on function wf_private.payroll_reopen_commercial(jsonb)
from public,anon,authenticated,service_role;

create or replace function wf_private.payroll_command_commercial(
  p_action text,
  p jsonb
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  actor public.employees%rowtype;
  result jsonb;
  export_id uuid;
  first_day date:=(p->>'from')::date;
  last_day date:=(p->>'to')::date;
begin
  if p_action='payroll.reopen' then return wf_private.payroll_reopen_commercial(p); end if;
  actor:=wf_private.actor();
  if p_action='payroll.close' and exists(
    select 1 from public.attendance_periods period
    where period.organization_id=actor.organization_id
      and period.period_start=first_day and period.period_end=last_day
      and period.status='CLOSED'
  ) then
    return jsonb_build_object('ok',true,'count',0,'already_closed',true);
  end if;
  result:=wf_private.payroll_command(p_action,p);
  if p_action='payroll.close' then
    update public.work_sessions
    set status_before_lock=status,status='LOCKED',locked_at=clock_timestamp(),
        locked_by=actor.employee_id
    where organization_id=actor.organization_id
      and business_date between first_day and last_day
      and status not in ('CANCELLED','LOCKED');
  elsif p_action='payroll.export' then
    export_id:=(result->>'export_id')::uuid;
    insert into public.hris_export_outbox(
      organization_id,integration_id,payroll_export_id,payload
    )
    select actor.organization_id,integration.id,export_id,
      jsonb_build_object(
        'contract','genai.workforce.payroll','version','2026-09-01',
        'organization_id',actor.organization_id,'period',jsonb_build_object('from',first_day,'to',last_day),
        'base_rows',result->'rows',
        'overtime',(
          select coalesce(jsonb_agg(jsonb_build_object(
            'employee_code',employee.employee_code,
            'minutes',ledger.minutes,'request_id',ledger.request_id
          ) order by employee.employee_code,ledger.created_at),'[]')
          from public.workforce_overtime_ledger ledger
          join public.employees employee
            on employee.organization_id=ledger.organization_id
           and employee.internal_id=ledger.employee_internal_id
          where ledger.organization_id=actor.organization_id
            and wf_private.organization_local_date(actor.organization_id,ledger.start_at)
                between first_day and last_day
            and ledger.payroll_state='APPROVED'
        )
      )
    from public.workforce_integrations integration
    where integration.organization_id=actor.organization_id
      and integration.kind in ('HRIS','PAYROLL') and integration.enabled
    on conflict(organization_id,payroll_export_id,integration_id) do nothing;
  end if;
  return result;
end;
$$;
revoke all on function wf_private.payroll_command_commercial(text,jsonb)
from public,anon,authenticated,service_role;

create or replace function public.workforce_hris_worker_v1(
  p_action text,
  p_args jsonb default '{}'
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  item public.hris_export_outbox%rowtype;
  integration public.workforce_integrations%rowtype;
  lease uuid;
begin
  if p_action='claim' then
    select * into item from public.hris_export_outbox candidate
    where (
        candidate.state in ('PENDING','FAILED')
        or (candidate.state='PROCESSING' and candidate.lease_expires_at<=clock_timestamp())
      )
      and candidate.available_at<=clock_timestamp() and candidate.attempts<20
    order by candidate.available_at,candidate.id limit 1 for update skip locked;
    if item.id is null then return jsonb_build_object('item',null); end if;
    lease:=extensions.gen_random_uuid();
    update public.hris_export_outbox
    set state='PROCESSING',lease_token=lease,leased_at=clock_timestamp(),
        lease_expires_at=clock_timestamp()+interval '5 minutes',
        attempts=attempts+1
    where id=item.id;
    select * into integration from public.workforce_integrations candidate
    where candidate.id=item.integration_id
      and candidate.organization_id=item.organization_id
      and candidate.enabled;
    if integration.id is null then
      update public.hris_export_outbox
      set state='FAILED',lease_token=null,leased_at=null,lease_expires_at=null,
          last_error_code='INTEGRATION_DISABLED',
          available_at=clock_timestamp()+interval '15 minutes'
      where id=item.id;
      return jsonb_build_object('item',null,'code','INTEGRATION_DISABLED');
    end if;
    return jsonb_build_object('item',jsonb_build_object(
      'id',item.id,'lease',lease,'integration_id',item.integration_id,
      'contract_version',item.contract_version,'payload',item.payload,
      'endpoint',integration.endpoint,
      'secret_reference',integration.secret_reference,
      'timeout_seconds',least(120,greatest(5,coalesce((integration.config->>'timeout_seconds')::integer,30)))
    ));
  elsif p_action='finish' then
    select * into item from public.hris_export_outbox candidate
    where candidate.id=(p_args->>'id')::uuid
      and candidate.lease_token=(p_args->>'lease')::uuid
      and candidate.state='PROCESSING'
      and candidate.lease_expires_at>clock_timestamp() for update;
    if item.id is null then return jsonb_build_object('ok',false,'code','STALE_LEASE'); end if;
    update public.hris_export_outbox
    set state=case when coalesce((p_args->>'delivered')::boolean,false) then 'DELIVERED' else 'FAILED' end,
        delivered_at=case when coalesce((p_args->>'delivered')::boolean,false) then clock_timestamp() end,
        last_error_code=case when coalesce((p_args->>'delivered')::boolean,false) then null else left(coalesce(p_args->>'code','UNKNOWN'),80) end,
        available_at=clock_timestamp()+make_interval(mins=>least(60,power(2,attempts)::integer)),
        lease_token=null,leased_at=null,lease_expires_at=null
    where id=item.id;
    return jsonb_build_object('ok',true);
  end if;
  raise exception 'Unknown HRIS worker action.';
end;
$$;
revoke all on function public.workforce_hris_worker_v1(text,jsonb)
from public,anon,authenticated;
grant execute on function public.workforce_hris_worker_v1(text,jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- Identity posture (MFA/SSO/SCIM contracts) and privacy operations.
-- Provider credentials live in Vault/Edge secrets; database rows keep only
-- provider identifiers or one-way token hashes.
-- ---------------------------------------------------------------------------
create table public.organization_security_settings(
  organization_id uuid primary key references public.organizations(id) on delete restrict,
  require_mfa_for_admin boolean not null default false,
  allow_password_login boolean not null default true,
  session_max_minutes integer not null default 720 check(session_max_minutes between 15 and 43200),
  updated_at timestamptz not null default clock_timestamp(),
  updated_by text references public.employees(employee_id) on delete set null
);
insert into public.organization_security_settings(organization_id)
select id from public.organizations on conflict do nothing;

create table public.identity_providers(
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  kind text not null check(kind in ('SAML','OIDC','SCIM')),
  provider_reference text not null,
  domains text[] not null default '{}',
  enabled boolean not null default false,
  config jsonb not null default '{}',
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique(organization_id,kind,provider_reference)
);

create table public.scim_credentials(
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  token_hash text not null check(token_hash ~ '^[0-9a-f]{64}$'),
  label text not null,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  unique(token_hash)
);

create table public.scim_events(
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  external_id text not null,
  operation text not null check(operation in ('CREATE','UPDATE','DEACTIVATE','GROUP_SYNC')),
  subject_internal_id uuid,
  payload_hash text not null,
  outcome text not null,
  created_at timestamptz not null default clock_timestamp(),
  unique(organization_id,external_id,operation,payload_hash),
  foreign key(organization_id,subject_internal_id)
    references public.employees(organization_id,internal_id) on delete restrict
);

create table public.retention_policies(
  organization_id uuid not null references public.organizations(id) on delete restrict,
  resource text not null check(resource in ('ATTENDANCE_EVIDENCE','AUDIT','REQUESTS','NOTIFICATIONS','DEVICE_DATA','EXPORTS')),
  retention_days integer not null check(retention_days between 30 and 3650),
  legal_basis text not null check(char_length(legal_basis) between 5 and 500),
  active boolean not null default true,
  updated_at timestamptz not null default clock_timestamp(),
  updated_by text references public.employees(employee_id) on delete set null,
  primary key(organization_id,resource)
);
insert into public.retention_policies(organization_id,resource,retention_days,legal_basis)
select organization.id,policy.resource,policy.days,policy.basis
from public.organizations organization
cross join(values
  ('ATTENDANCE_EVIDENCE',2555,'Nghĩa vụ lao động và đối soát lương'),
  ('AUDIT',2555,'An ninh, chống gian lận và trách nhiệm giải trình'),
  ('REQUESTS',1825,'Thực hiện hợp đồng lao động'),
  ('NOTIFICATIONS',180,'Vận hành dịch vụ'),
  ('DEVICE_DATA',365,'Bảo vệ tài khoản và chống gian lận'),
  ('EXPORTS',730,'Đối soát hệ thống lương')
) policy(resource,days,basis)
on conflict do nothing;

create table public.legal_holds(
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  subject_employee_internal_id uuid,
  scope text[] not null default '{}',
  reason text not null check(char_length(reason) between 10 and 1000),
  starts_at timestamptz not null default clock_timestamp(),
  ends_at timestamptz,
  released_at timestamptz,
  created_by_internal_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  foreign key(organization_id,subject_employee_internal_id)
    references public.employees(organization_id,internal_id) on delete restrict,
  foreign key(organization_id,created_by_internal_id)
    references public.employees(organization_id,internal_id) on delete restrict,
  check(ends_at is null or ends_at>starts_at)
);

create table public.dsar_requests(
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  subject_employee_internal_id uuid not null,
  request_type text not null check(request_type in ('ACCESS','RECTIFICATION','ERASURE','RESTRICTION','PORTABILITY')),
  state text not null default 'RECEIVED' check(state in ('RECEIVED','VERIFYING','APPROVED','PROCESSING','COMPLETED','REJECTED','ON_HOLD')),
  reason text not null default '',
  due_at timestamptz not null default (clock_timestamp()+interval '30 days'),
  manifest jsonb,
  completed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  foreign key(organization_id,subject_employee_internal_id)
    references public.employees(organization_id,internal_id) on delete restrict
);
create index dsar_requests_queue_idx
  on public.dsar_requests(organization_id,state,due_at)
  where state not in ('COMPLETED','REJECTED');

do $$
declare relation text;
begin
  foreach relation in array array[
    'organization_security_settings','identity_providers','scim_credentials',
    'scim_events','retention_policies','legal_holds','dsar_requests'
  ] loop
    execute format('alter table public.%I enable row level security',relation);
    execute format(
      'revoke all on table public.%I from public,anon,authenticated,service_role',
      relation
    );
  end loop;
end;
$$;

create or replace function wf_private.require_commercial_mfa(
  p_organization_id uuid
)
returns void
language plpgsql
stable
security definer
set search_path=''
as $$
declare require_mfa boolean;
begin
  select setting.require_mfa_for_admin into require_mfa
  from public.organization_security_settings setting
  where setting.organization_id=p_organization_id;
  if coalesce(require_mfa,false)
    and coalesce((select auth.jwt()->>'aal'),'aal1')<>'aal2' then
    raise exception 'Thao tác này yêu cầu xác thực hai lớp.' using errcode='42501';
  end if;
end;
$$;
revoke all on function wf_private.require_commercial_mfa(uuid)
from public,anon,authenticated,service_role;

create or replace function wf_private.workflow_delegate(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare actor public.employees%rowtype; target public.employees%rowtype; delegation_id uuid;
begin
  actor:=wf_private.require_capability('attendance.review');
  perform wf_private.require_commercial_mfa(actor.organization_id);
  select * into target from public.employees employee
  where employee.organization_id=actor.organization_id
    and employee.internal_id=(p->>'to_employee_internal_id')::uuid
    and employee.status='Active' and employee.internal_id<>actor.internal_id;
  if target.internal_id is null or not wf_private.employee_capable(
    actor.organization_id,target.employee_id,'attendance.review'
  ) then raise exception 'Người được ủy quyền không hợp lệ.' using errcode='22023'; end if;
  insert into public.workflow_delegations(
    organization_id,from_employee_internal_id,to_employee_internal_id,
    request_types,starts_at,ends_at,reason,created_by_internal_id
  ) values(
    actor.organization_id,actor.internal_id,target.internal_id,
    coalesce(array(select jsonb_array_elements_text(p->'request_types')),'{}'),
    coalesce((p->>'starts_at')::timestamptz,clock_timestamp()),
    (p->>'ends_at')::timestamptz,trim(p->>'reason'),actor.internal_id
  ) returning id into delegation_id;
  perform wf_private.audit(
    'WORKFLOW_DELEGATED','workflow_delegation',delegation_id::text,p->>'reason',
    jsonb_build_object('to_employee_id',target.employee_id,'request_types',p->'request_types')
  );
  return jsonb_build_object('ok',true,'id',delegation_id);
end;
$$;
revoke all on function wf_private.workflow_delegate(jsonb)
from public,anon,authenticated,service_role;

create or replace function wf_private.privacy_command(p_action text,p jsonb)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  actor public.employees%rowtype;
  subject public.employees%rowtype;
  request public.dsar_requests%rowtype;
  request_type text;
  export_manifest jsonb;
begin
  actor:=wf_private.actor();
  if p_action='privacy.request' then
    request_type:=upper(p->>'request_type');
    if request_type not in ('ACCESS','RECTIFICATION','ERASURE','RESTRICTION','PORTABILITY') then
      raise exception 'Loại yêu cầu quyền dữ liệu không hợp lệ.' using errcode='22023';
    end if;
    insert into public.dsar_requests(
      organization_id,subject_employee_internal_id,request_type,reason
    ) values(
      actor.organization_id,actor.internal_id,request_type,left(coalesce(p->>'reason',''),1000)
    ) returning * into request;
    perform wf_private.audit(
      'DSAR_RECEIVED','dsar_request',request.id::text,'Tiếp nhận yêu cầu quyền dữ liệu',
      jsonb_build_object('type',request_type)
    );
    return jsonb_build_object('ok',true,'id',request.id,'due_at',request.due_at);
  end if;

  perform wf_private.require_capability('employee.manage');
  perform wf_private.require_commercial_mfa(actor.organization_id);
  select * into request from public.dsar_requests candidate
  where candidate.id=(p->>'id')::uuid
    and candidate.organization_id=actor.organization_id for update;
  if request.id is null then raise exception 'Không tìm thấy yêu cầu DSAR.'; end if;
  select * into subject from public.employees employee
  where employee.organization_id=actor.organization_id
    and employee.internal_id=request.subject_employee_internal_id;
  if p_action='privacy.export' then
    if request.request_type not in ('ACCESS','PORTABILITY')
      or request.state<>'APPROVED' then
      raise exception 'Chỉ yêu cầu truy cập/di chuyển dữ liệu đã duyệt mới được xuất.'
        using errcode='55000';
    end if;
    update public.dsar_requests
    set state='PROCESSING',updated_at=clock_timestamp()
    where id=request.id and state='APPROVED';
    export_manifest:=jsonb_build_object(
      'version','2026-09-01','generated_at',clock_timestamp(),
      'subject',to_jsonb(subject)-'auth_user_id'-'trusted_device_id',
      'work_sessions',(
        select coalesce(jsonb_agg(to_jsonb(session) order by session.business_date,session.session_sequence),'[]')
        from public.work_sessions session
        where session.organization_id=actor.organization_id
          and session.employee_internal_id=subject.internal_id
      ),
      'requests',(
        select coalesce(jsonb_agg(to_jsonb(item) order by item.created_at),'[]')
        from public.attendance_requests item
        where item.organization_id=actor.organization_id
          and item.employee_id=subject.employee_id
      ),
      'workflow_decisions',(
        select coalesce(jsonb_agg(to_jsonb(decision) order by decision.created_at),'[]')
        from public.workflow_decisions decision
        where decision.organization_id=actor.organization_id
          and decision.actor_employee_internal_id=subject.internal_id
      )
    );
    update public.dsar_requests
    set state='COMPLETED',manifest=export_manifest,
        completed_at=clock_timestamp(),updated_at=clock_timestamp()
    where id=request.id;
    perform wf_private.audit(
      'DSAR_EXPORTED','dsar_request',request.id::text,'Xuất dữ liệu theo yêu cầu',
      jsonb_build_object('subject_internal_id',subject.internal_id)
    );
    return jsonb_build_object('ok',true,'manifest',export_manifest);
  elsif p_action='privacy.hold' then
    if request.state in ('COMPLETED','REJECTED') then
      raise exception 'Không thể giữ một yêu cầu đã kết thúc.' using errcode='55000';
    end if;
    insert into public.legal_holds(
      organization_id,subject_employee_internal_id,scope,reason,
      ends_at,created_by_internal_id
    ) values(
      actor.organization_id,subject.internal_id,
      coalesce(array(select jsonb_array_elements_text(p->'scope')),'{}'),
      trim(p->>'reason'),(p->>'ends_at')::timestamptz,actor.internal_id
    );
    update public.dsar_requests set state='ON_HOLD',updated_at=clock_timestamp()
    where id=request.id;
    perform wf_private.audit(
      'LEGAL_HOLD_CREATED','dsar_request',request.id::text,p->>'reason',
      jsonb_build_object('subject_internal_id',subject.internal_id)
    );
    return jsonb_build_object('ok',true);
  elsif p_action='privacy.approve' then
    if request.state not in ('RECEIVED','VERIFYING','ON_HOLD') then
      raise exception 'Trạng thái yêu cầu không cho phép phê duyệt.' using errcode='55000';
    end if;
    if exists(
      select 1 from public.legal_holds hold
      where hold.organization_id=actor.organization_id
        and (hold.subject_employee_internal_id is null or hold.subject_employee_internal_id=subject.internal_id)
        and hold.released_at is null
        and (hold.ends_at is null or hold.ends_at>clock_timestamp())
    ) then raise exception 'Yêu cầu đang chịu legal hold.' using errcode='55000'; end if;
    update public.dsar_requests set state='APPROVED',updated_at=clock_timestamp()
    where id=request.id;
    perform wf_private.audit(
      'DSAR_APPROVED','dsar_request',request.id::text,left(coalesce(p->>'reason',''),1000),
      jsonb_build_object('type',request.request_type)
    );
    return jsonb_build_object('ok',true,'state','APPROVED');
  end if;
  raise exception 'Unknown privacy action.';
end;
$$;
revoke all on function wf_private.privacy_command(text,jsonb)
from public,anon,authenticated,service_role;

create or replace function wf_private.cancel_request_commercial(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  actor public.employees%rowtype;
  request public.attendance_requests%rowtype;
  session public.work_sessions%rowtype;
  restored_status text;
  result jsonb;
begin
  actor:=wf_private.actor();
  select * into request from public.attendance_requests candidate
  where candidate.id=(p->>'id')::uuid
    and candidate.organization_id=actor.organization_id
  for update;
  if request.id is null then
    raise exception 'Không tìm thấy yêu cầu.' using errcode='42501';
  end if;
  if request.work_session_id is not null then
    select * into session from public.work_sessions candidate
    where candidate.organization_id=actor.organization_id
      and candidate.id=request.work_session_id
    for update;
  end if;

  result:=wf_private.command_v4('request.cancel',p);
  if session.id is not null then
    restored_status:=coalesce(
      nullif(request.workflow_data->>'previous_session_status',''),
      'NEEDS_REVIEW'
    );
    if restored_status not in (
      'SCHEDULED','OPEN','COMPLETE','AUTO_APPROVED','NEEDS_REVIEW',
      'APPROVED','REJECTED','CANCELLED'
    ) then
      restored_status:='NEEDS_REVIEW';
    end if;
    update public.work_sessions
    set status=restored_status
    where id=session.id and status='PENDING_REVIEW';
    perform wf_private.refresh_timesheet_from_sessions(
      actor.organization_id,session.employee_internal_id,session.business_date
    );
  end if;
  return result;
end;
$$;
revoke all on function wf_private.cancel_request_commercial(jsonb)
from public,anon,authenticated,service_role;

create or replace function wf_private.sync_request_workflow_state()
returns trigger language plpgsql security definer set search_path=''
as $$
begin
  if new.status in ('CANCELLED','REJECTED','APPROVED')
    and new.status is distinct from old.status
    and new.workflow_instance_id is not null then
    update public.workflow_instances
    set state=new.status,
        completed_at=coalesce(completed_at,clock_timestamp())
    where id=new.workflow_instance_id;
    update public.workflow_steps
    set status='SKIPPED',completed_at=clock_timestamp()
    where instance_id=new.workflow_instance_id and status in ('PENDING','ACTIVE');
  end if;
  return new;
end;
$$;
revoke all on function wf_private.sync_request_workflow_state()
from public,anon,authenticated,service_role;
create trigger attendance_requests_sync_workflow_state
after update of status on public.attendance_requests
for each row execute function wf_private.sync_request_workflow_state();

alter table public.audit_logs
  add column correlation_id uuid;
alter table public.audit_logs
  alter column correlation_id set default extensions.gen_random_uuid();
create index audit_logs_correlation_idx
  on public.audit_logs(organization_id,correlation_id,created_at);
alter table public.workforce_metrics
  add column correlation_id uuid;
alter table public.workforce_metrics
  alter column correlation_id set default
    nullif(pg_catalog.current_setting('workforce.correlation_id',true),'')::uuid;

create or replace function wf_private.audit(
  p_action text,
  p_entity text,
  p_id text,
  p_reason text,
  p_metadata jsonb default '{}'
)
returns void
language plpgsql
security definer
set search_path=''
as $$
declare
  actor public.employees%rowtype;
  correlation uuid;
begin
  actor:=wf_private.actor();
  begin
    correlation:=nullif(
      pg_catalog.current_setting('workforce.correlation_id',true),''
    )::uuid;
  exception when others then
    correlation:=null;
  end;
  insert into public.audit_logs(
    organization_id,actor_employee_id,action,entity_type,entity_id,
    reason,metadata,correlation_id
  ) values(
    actor.organization_id,actor.employee_id,p_action,p_entity,p_id,
    left(p_reason,1000),
    p_metadata||jsonb_build_object(
      'organization_id',actor.organization_id,
      'workforce_version',4
    ),
    coalesce(correlation,extensions.gen_random_uuid())
  );
end;
$$;
revoke all on function wf_private.audit(text,text,text,text,jsonb)
from public,anon,authenticated,service_role;

create or replace function wf_private.command_commercial(
  p_action text,
  p jsonb
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  actor public.employees%rowtype;
  item jsonb;
  count_reviewed integer:=0;
  correlation uuid;
  result jsonb;
begin
  actor:=wf_private.actor();
  begin correlation:=coalesce((p->>'correlation_id')::uuid,extensions.gen_random_uuid());
  exception when others then correlation:=extensions.gen_random_uuid(); end;
  p:=p||jsonb_build_object('correlation_id',correlation);
  perform pg_catalog.set_config(
    'workforce.correlation_id',correlation::text,true
  );
  if p_action='request.submit' then
    result:=wf_private.submit_request_commercial(p);
  elsif p_action='request.review' then
    result:=wf_private.review_request_commercial(p);
  elsif p_action='request.review_many' then
    if jsonb_typeof(p->'requests')<>'array'
      or jsonb_array_length(p->'requests') not between 1 and 100 then
      raise exception 'Chọn 1–100 yêu cầu.';
    end if;
    for item in select value from jsonb_array_elements(p->'requests') order by value->>'id' loop
      perform wf_private.review_request_commercial(
        item||jsonb_build_object(
          'decision',p->>'decision','note',p->>'note','correlation_id',correlation
        )
      );
      count_reviewed:=count_reviewed+1;
    end loop;
    result:=jsonb_build_object('ok',true,'count',count_reviewed);
  elsif p_action='request.cancel' then
    result:=wf_private.cancel_request_commercial(p);
  elsif p_action in ('payroll.export','payroll.close','payroll.reopen') then
    perform wf_private.require_commercial_mfa(actor.organization_id);
    result:=wf_private.payroll_command_commercial(p_action,p);
  elsif p_action='maintenance.run' then
    raise exception using
      errcode='42501',
      message='Maintenance action is service-only.';
  elsif p_action='workflow.delegate' then
    result:=wf_private.workflow_delegate(p);
  elsif p_action like 'privacy.%' then
    result:=wf_private.privacy_command(p_action,p);
  else
    result:=wf_private.command_v4(p_action,p);
  end if;
  return result||jsonb_build_object('correlation_id',correlation);
end;
$$;
revoke all on function wf_private.command_commercial(text,jsonb)
from public,anon,authenticated,service_role;

create or replace function public.workforce_command(
  p_action text,
  p_args jsonb default '{}'
)
returns jsonb
language sql
security invoker
set search_path=''
as $$ select wf_private.command_commercial(p_action,p_args) $$;
revoke all on function public.workforce_command(text,jsonb) from public,anon;
grant execute on function public.workforce_command(text,jsonb) to authenticated;
grant execute on function wf_private.command_commercial(text,jsonb),
  wf_private.submit_request_commercial(jsonb),
  wf_private.review_request_commercial(jsonb),
  wf_private.cancel_request_commercial(jsonb),
  wf_private.payroll_command_commercial(text,jsonb),
  wf_private.workflow_delegate(jsonb),wf_private.privacy_command(text,jsonb)
to authenticated;

create or replace function wf_private.query_ga(
  p_resource text,
  p jsonb default '{}'
)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare actor public.employees%rowtype; rows jsonb; request_id uuid;
begin
  actor:=wf_private.actor();
  if p_resource='request.detail' then
    begin request_id:=(p->>'id')::uuid;
    exception when others then raise exception 'Mã đề xuất không hợp lệ.' using errcode='22023'; end;
    return jsonb_build_object('row',(
      select to_jsonb(request)
      from public.attendance_requests request
      where request.id=request_id
        and request.organization_id=actor.organization_id
        and (
          request.employee_id=actor.employee_id
          or request.workflow_data->>'peer_employee_id'=actor.employee_id
          or (
            request.employee_id in(select wf_private.scope_ids())
            and wf_private.approval_role_allowed(request.organization_id,request.request_type)
          )
      )
    ));
  elsif p_resource='assignment.detail' then
    perform wf_private.require_capability('schedule.manage');
    begin request_id:=(p->>'id')::uuid;
    exception when others then raise exception 'Mã lịch phân ca không hợp lệ.' using errcode='22023'; end;
    return jsonb_build_object('row',(
      select to_jsonb(assignment)
      from public.shift_assignments assignment
      where assignment.id=request_id
        and assignment.organization_id=actor.organization_id
        and assignment.employee_id in(select wf_private.scope_ids())
    ));
  elsif p_resource='admin.config' then
    rows:=wf_private.query_v4('admin_config',p);
    return rows||jsonb_build_object(
      'config_revision',coalesce((
        select revision from public.organization_config_versions version
        where version.organization_id=actor.organization_id
      ),1),
      'timezone',wf_private.organization_timezone(actor.organization_id),
      'attendancePeriods',(
        select coalesce(jsonb_agg(to_jsonb(period) order by period.period_start desc),'[]')
        from public.attendance_periods period
        where period.organization_id=actor.organization_id
      )
    );
  elsif p_resource='workflow' then
    perform wf_private.require_capability('attendance.review');
    select coalesce(jsonb_agg(to_jsonb(queue) order by queue.due_at,queue.request_id),'[]')
    into rows
    from (
      select step.id as step_id,step.instance_id,step.step_no,step.role,
        step.due_at,instance.request_id,request.request_code,request.request_type,
        request.reason,request.from_date,request.to_date,employee.name as employee_name,
        delegation.id as delegation_id
      from public.workflow_steps step
      join public.workflow_instances instance on instance.id=step.instance_id
      join public.attendance_requests request on request.id=instance.request_id
      join public.employees employee
        on employee.organization_id=request.organization_id
       and employee.employee_id=request.employee_id
      left join public.workflow_delegations delegation
        on delegation.organization_id=step.organization_id
       and delegation.from_employee_internal_id=step.assigned_employee_internal_id
       and delegation.to_employee_internal_id=actor.internal_id
       and delegation.revoked_at is null
       and clock_timestamp()>=delegation.starts_at and clock_timestamp()<delegation.ends_at
       and (cardinality(delegation.request_types)=0 or request.request_type=any(delegation.request_types))
      where step.organization_id=actor.organization_id and step.status='ACTIVE'
        and (
          step.assigned_employee_internal_id=actor.internal_id
          or delegation.id is not null
          or wf_private.capable('attendance.review.override')
        )
    ) queue;
    return jsonb_build_object('rows',rows,'server_time',clock_timestamp());
  elsif p_resource='commercial_config' then
    if not(
      wf_private.capable('settings.manage')
      or wf_private.capable('employee.manage')
    ) then raise exception 'Không có quyền đọc cấu hình thương mại.' using errcode='42501'; end if;
    perform wf_private.require_commercial_mfa(actor.organization_id);
    return jsonb_build_object(
      'security',(select to_jsonb(setting) from public.organization_security_settings setting where setting.organization_id=actor.organization_id),
      'identity_providers',(select coalesce(jsonb_agg(to_jsonb(provider)-'config' order by provider.created_at),'[]') from public.identity_providers provider where provider.organization_id=actor.organization_id),
      'integrations',(select coalesce(jsonb_agg(to_jsonb(integration)-'secret_reference' order by integration.kind,integration.name),'[]') from public.workforce_integrations integration where integration.organization_id=actor.organization_id),
      'retention',(select coalesce(jsonb_agg(to_jsonb(policy) order by policy.resource),'[]') from public.retention_policies policy where policy.organization_id=actor.organization_id)
    );
  elsif p_resource='privacy' then
    return jsonb_build_object('rows',(
      select coalesce(jsonb_agg(to_jsonb(request)-'manifest' order by request.created_at desc),'[]')
      from public.dsar_requests request
      where request.organization_id=actor.organization_id
        and (
          request.subject_employee_internal_id=actor.internal_id
          or wf_private.capable('employee.manage')
        )
    ));
  elsif p_resource='observability' then
    perform wf_private.require_capability('audit.view');
    return jsonb_build_object(
      'server_time',clock_timestamp(),
      'attendance_p95_ms',(
        select percentile_disc(0.95) within group(order by metric.duration_ms)
        from public.workforce_metrics metric
        where metric.organization_id=actor.organization_id
          and metric.created_at>=clock_timestamp()-interval '24 hours'
          and metric.kind='ATTENDANCE' and metric.duration_ms is not null
      ),
      'attendance_failures',(
        select count(*) from public.workforce_metrics metric
        where metric.organization_id=actor.organization_id
          and metric.created_at>=clock_timestamp()-interval '24 hours'
          and metric.kind='ATTENDANCE' and metric.code<>'SUCCESS'
      ),
      'maintenance_backlog',(
        select count(*) from wf_private.maintenance_jobs job
        where job.organization_id=actor.organization_id
          and job.state in ('PENDING','FAILED')
      ),
      'hris_backlog',(
        select count(*) from public.hris_export_outbox job
        where job.organization_id=actor.organization_id
          and job.state in ('PENDING','FAILED')
      ),
      'dsar_overdue',(
        select count(*) from public.dsar_requests request
        where request.organization_id=actor.organization_id
          and request.state not in ('COMPLETED','REJECTED')
          and request.due_at<clock_timestamp()
      )
    );
  end if;
  return wf_private.query_commercial(p_resource,p);
end;
$$;
revoke all on function wf_private.query_ga(text,jsonb)
from public,anon,authenticated,service_role;

create or replace function public.workforce_query(
  p_resource text,
  p_args jsonb default '{}'
)
returns jsonb
language sql
security invoker
set search_path=''
as $$ select wf_private.query_ga(p_resource,p_args) $$;
revoke all on function public.workforce_query(text,jsonb) from public,anon;
grant execute on function public.workforce_query(text,jsonb) to authenticated;
grant execute on function wf_private.query_ga(text,jsonb) to authenticated;

do $verify$
begin
  if exists(
    select 1 from public.workflow_decisions decision
    group by decision.step_id having count(*)>1
  ) then raise exception 'Workflow step has multiple final decisions.'; end if;
  if has_function_privilege('authenticated','public.workforce_hris_worker_v1(text,jsonb)','execute') then
    raise exception 'HRIS worker must remain service-role only.';
  end if;
  if exists(
    select 1 from public.work_sessions session
    where session.assignment_id is not null
      and not exists(
        select 1 from public.shift_assignments assignment
        where assignment.id=session.assignment_id
          and assignment.organization_id=session.organization_id
          and assignment.employee_internal_id=session.employee_internal_id
      )
  ) then raise exception 'Cross-tenant work-session assignment detected.'; end if;
end;
$verify$;

notify pgrst,'reload schema';
