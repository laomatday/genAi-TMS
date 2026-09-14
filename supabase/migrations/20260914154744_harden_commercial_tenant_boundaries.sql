-- Close the remaining cross-tenant boundaries before a shared commercial
-- deployment. Tenant identity is derived from the authenticated employee and is
-- part of every uniqueness rule that represents customer-owned data.
set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- ---------------------------------------------------------------------------
-- 1. Attendance periods must be unique per organization, not per database.
-- ---------------------------------------------------------------------------
alter table public.attendance_periods
  alter column organization_id set default tms_private.request_organization();

alter table public.attendance_periods
  drop constraint if exists attendance_periods_period_start_period_end_key;
alter table public.attendance_periods
  add constraint attendance_periods_organization_period_key
  unique (organization_id, period_start, period_end);

drop policy if exists attendance_periods_admin_read on public.attendance_periods;
drop policy if exists attendance_periods_read_tenant on public.attendance_periods;
create policy attendance_periods_read_tenant
on public.attendance_periods for select to authenticated
using (
  organization_id = (select wf_private.current_organization())
  and (select tms_private.is_admin_operator())
);

-- Re-publish the command because its conflict target must match the new
-- tenant-scoped uniqueness constraint.
create or replace function wf_private.payroll_command(p_action text,p jsonb)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  a public.employees%rowtype;
  first_day date := (p->>'from')::date;
  last_day date := (p->>'to')::date;
  checklist jsonb;
  rows jsonb;
  hash text;
  export_id uuid;
  why text := trim(coalesce(p->>'note',''));
  n integer;
begin
  a := wf_private.require_capability(
    case
      when p_action='payroll.close' then 'attendance.lock_period'
      when p_action='payroll.reopen' then 'attendance.reopen_period'
      else 'attendance.export'
    end
  );
  if not wf_private.capable('team.read_all') then
    raise exception 'Cần phạm vi toàn tổ chức.' using errcode='42501';
  end if;
  perform wf_private.period_lock(a.organization_id,first_day,last_day,true);
  checklist := wf_private.payroll_checklist(first_day,last_day);

  if p_action='payroll.export' then
    select coalesce(jsonb_agg(to_jsonb(x) order by x.employee_id),'[]')
    into rows
    from (
      select
        e.employee_id,
        e.name,
        e.center_id,
        sum(t.work_minutes) filter(
          where t.status in ('COMPLETE','AUTO_APPROVED','APPROVED','LOCKED')
        ) as accepted_work_minutes,
        sum(t.paid_leave_minutes) as approved_annual_leave_minutes,
        sum(t.late_minutes) as late_minutes,
        sum(t.early_minutes) as early_minutes,
        count(*) filter(
          where t.status in ('SCHEDULED','OPEN','EXCEPTION','PENDING_REVIEW','REJECTED')
        ) as unresolved_days,
        count(*) as recorded_days
      from public.timesheets t
      join public.employees e using(employee_id)
      where t.organization_id=a.organization_id
        and t.work_date between first_day and last_day
        and t.status<>'CANCELLED'
      group by e.employee_id,e.name,e.center_id
    ) x;
    hash := wf_private.fingerprint(first_day,last_day);
    insert into public.workforce_payroll_exports(
      organization_id,period_start,period_end,created_by,fingerprint,payload
    )
    values(a.organization_id,first_day,last_day,a.employee_id,hash,rows)
    returning id into export_id;
    perform wf_private.audit(
      'PAYROLL_EXPORT_CREATED',
      'payroll_export',
      export_id::text,
      'Xuất dữ liệu đối soát, không phải bảng lương',
      jsonb_build_object('from',first_day,'to',last_day,'fingerprint',hash)
    );
    return jsonb_build_object(
      'ok',true,
      'export_id',export_id,
      'fingerprint',hash,
      'rows',rows,
      'draft',not coalesce((checklist->>'closed')::boolean,false)
    );
  elsif p_action='payroll.close' then
    if not coalesce((checklist->>'ready')::boolean,false) then
      raise exception 'Chưa đủ điều kiện đóng kỳ. Xử lý checklist và xuất lại bản đối soát.';
    end if;
    if length(why)<5 then
      raise exception 'Ghi chú đóng kỳ cần ít nhất 5 ký tự.';
    end if;
    update public.timesheets
    set status_before_lock=status,
        status='LOCKED',
        locked_at=clock_timestamp(),
        locked_by=a.employee_id
    where organization_id=a.organization_id
      and work_date between first_day and last_day
      and status<>'CANCELLED';
    get diagnostics n=row_count;
    insert into public.attendance_periods(
      period_start,period_end,status,closed_by,closed_at,note,organization_id
    )
    values(first_day,last_day,'CLOSED',a.employee_id,clock_timestamp(),why,a.organization_id)
    on conflict(organization_id,period_start,period_end)
    do update
    set status='CLOSED',
        closed_by=excluded.closed_by,
        closed_at=excluded.closed_at,
        note=excluded.note,
        updated_at=clock_timestamp();
    perform wf_private.audit(
      'PAYROLL_PERIOD_CLOSED',
      'attendance_period',
      first_day::text,
      why,
      jsonb_build_object(
        'count',n,
        'export_id',checklist->>'export_id',
        'fingerprint',checklist->>'fingerprint'
      )
    );
    return jsonb_build_object('ok',true,'count',n);
  elsif p_action='payroll.reopen' then
    if length(why)<10 then
      raise exception 'Mở lại kỳ phải có lý do ít nhất 10 ký tự.';
    end if;
    if not exists(
      select 1
      from public.attendance_periods
      where organization_id=a.organization_id
        and period_start=first_day
        and period_end=last_day
        and status='CLOSED'
    ) then
      raise exception 'Kỳ công chưa đóng.';
    end if;
    raise exception 'Mở lại kỳ cần quy trình HR có đối soát; chưa bật thao tác này trong bản phát hành.';
  end if;
  raise exception 'Unknown payroll action';
end
$function$;

revoke all on function wf_private.payroll_command(text,jsonb)
from public,anon,authenticated;

-- ---------------------------------------------------------------------------
-- 2. Audit rows carry an indexed, typed tenant key. A trigger protects every
-- writer, including service-role Edge Functions that omit organization_id.
-- ---------------------------------------------------------------------------
alter table public.audit_logs
  add column organization_id uuid references public.organizations(id);

do $$
begin
  if exists(
    select 1
    from public.audit_logs log
    left join public.employees actor
      on actor.employee_id=log.actor_employee_id
    left join public.employees target
      on target.employee_id=log.target_employee_id
    left join public.organizations metadata_organization
      on metadata_organization.id::text=log.metadata->>'organization_id'
    where (
      actor.organization_id is not null
      and target.organization_id is not null
      and actor.organization_id<>target.organization_id
    ) or (
      actor.organization_id is not null
      and metadata_organization.id is not null
      and actor.organization_id<>metadata_organization.id
    ) or (
      target.organization_id is not null
      and metadata_organization.id is not null
      and target.organization_id<>metadata_organization.id
    ) or (
      log.metadata ? 'organization_id'
      and metadata_organization.id is null
    )
  ) then
    raise exception 'Audit tenant backfill found conflicting or invalid organization evidence.';
  end if;
end;
$$;

update public.audit_logs log
set organization_id = coalesce(
  (
    select employee.organization_id
    from public.employees employee
    where employee.employee_id=log.actor_employee_id
  ),
  (
    select employee.organization_id
    from public.employees employee
    where employee.employee_id=log.target_employee_id
  ),
  (
    select organization.id
    from public.organizations organization
    where organization.id::text=log.metadata->>'organization_id'
  ),
  (
    select organization.id
    from public.organizations organization
    where (select count(*) from public.organizations)=1
    limit 1
  )
);

do $$
begin
  if exists(select 1 from public.audit_logs where organization_id is null) then
    raise exception 'Audit tenant backfill has unresolved rows; classify them before deployment.';
  end if;
end;
$$;

update public.audit_logs
set metadata = metadata || jsonb_build_object('organization_id',organization_id);

alter table public.audit_logs
  alter column organization_id set not null;

create index audit_logs_organization_created_idx
  on public.audit_logs(organization_id,created_at desc,id);

create or replace function tms_private.assign_audit_organization()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
declare
  actor_organization uuid;
  target_organization uuid;
  metadata_organization uuid;
  resolved_organization uuid;
begin
  select employee.organization_id
  into actor_organization
  from public.employees employee
  where employee.employee_id=new.actor_employee_id;

  select employee.organization_id
  into target_organization
  from public.employees employee
  where employee.employee_id=new.target_employee_id;

  select organization.id
  into metadata_organization
  from public.organizations organization
  where organization.id::text=new.metadata->>'organization_id';

  if actor_organization is not null
    and target_organization is not null
    and actor_organization<>target_organization then
    raise exception 'Cross-tenant audit target is not allowed.' using errcode='42501';
  end if;

  resolved_organization := coalesce(
    actor_organization,
    target_organization,
    metadata_organization,
    new.organization_id
  );
  if resolved_organization is null then
    raise exception 'Audit organization could not be resolved.';
  end if;
  if new.organization_id is not null
    and new.organization_id<>resolved_organization then
    raise exception 'Audit organization does not match its actor.' using errcode='42501';
  end if;
  if metadata_organization is not null
    and metadata_organization<>resolved_organization then
    raise exception 'Audit metadata organization does not match its actor.' using errcode='42501';
  end if;

  new.organization_id := resolved_organization;
  new.metadata := new.metadata || jsonb_build_object(
    'organization_id',
    resolved_organization
  );
  return new;
end;
$$;

revoke all on function tms_private.assign_audit_organization()
from public,anon,authenticated;

create trigger audit_logs_assign_organization
before insert or update of actor_employee_id,target_employee_id,organization_id,metadata
on public.audit_logs
for each row execute function tms_private.assign_audit_organization();

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
  a public.employees%rowtype;
begin
  a := wf_private.actor();
  insert into public.audit_logs(
    organization_id,
    actor_employee_id,
    action,
    entity_type,
    entity_id,
    reason,
    metadata
  )
  values(
    a.organization_id,
    a.employee_id,
    p_action,
    p_entity,
    p_id,
    left(p_reason,1000),
    p_metadata || jsonb_build_object(
      'organization_id',a.organization_id,
      'workforce_version',3
    )
  );
end;
$$;

revoke all on function wf_private.audit(text,text,text,text,jsonb)
from public,anon,authenticated;

drop policy if exists tms_v2_audit_admin_read on public.audit_logs;
drop policy if exists audit_logs_read_tenant on public.audit_logs;
create policy audit_logs_read_tenant
on public.audit_logs for select to authenticated
using (
  organization_id = (select wf_private.current_organization())
  and (select tms_private.is_admin_operator())
);

-- ---------------------------------------------------------------------------
-- 3. Attendance policy names and references belong to one organization.
-- ---------------------------------------------------------------------------
alter table public.attendance_policies
  drop constraint if exists attendance_policies_name_key;
alter table public.attendance_policies
  add constraint attendance_policies_organization_name_key
  unique (organization_id,name),
  add constraint attendance_policies_organization_id_key
  unique (organization_id,id);

alter table public.employees
  drop constraint if exists employees_attendance_policy_id_fkey;
alter table public.employees
  add constraint employees_organization_attendance_policy_fk
  foreign key (organization_id,attendance_policy_id)
  references public.attendance_policies(organization_id,id)
  on update cascade on delete restrict;

alter table public.timesheets
  drop constraint if exists timesheets_policy_id_fkey;
alter table public.timesheets
  add constraint timesheets_organization_policy_fk
  foreign key (organization_id,policy_id)
  references public.attendance_policies(organization_id,id)
  on update cascade on delete restrict;

notify pgrst, 'reload schema';
