-- Commercial domain v4.
--
-- This migration introduces tenant-owned surrogate identities and makes a work
-- session (not a calendar-day aggregate) the source of truth for attendance.
-- The existing timesheets table remains as a compatibility/day aggregate while
-- clients and payroll are migrated to session-aware resources.
set local lock_timeout = '5s';
set local statement_timeout = '180s';

-- ---------------------------------------------------------------------------
-- Tenant timezone is data, never a process-wide constant.
-- ---------------------------------------------------------------------------
create or replace function wf_private.validate_organization_timezone()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
begin
  if not exists(
    select 1 from pg_catalog.pg_timezone_names zone where zone.name=new.timezone
  ) then
    raise exception 'Múi giờ IANA không hợp lệ: %',new.timezone using errcode='22023';
  end if;
  return new;
end;
$$;
revoke all on function wf_private.validate_organization_timezone()
from public,anon,authenticated,service_role;

drop trigger if exists organizations_validate_timezone on public.organizations;
create trigger organizations_validate_timezone
before insert or update of timezone on public.organizations
for each row execute function wf_private.validate_organization_timezone();

create or replace function wf_private.organization_timezone(p_organization_id uuid)
returns text
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  organization_timezone text;
begin
  select organization.timezone into organization_timezone
  from public.organizations organization
  where organization.id=p_organization_id;
  if organization_timezone is null then
    raise exception 'Không tìm thấy múi giờ của tổ chức.' using errcode='23503';
  end if;
  return organization_timezone;
end;
$$;

create or replace function wf_private.organization_local_date(
  p_organization_id uuid,
  p_instant timestamptz default clock_timestamp()
)
returns date
language sql
stable
security definer
set search_path=''
as $$
  select (p_instant at time zone wf_private.organization_timezone(p_organization_id))::date
$$;

create or replace function wf_private.organization_instant(
  p_organization_id uuid,
  p_local_date date,
  p_local_time time
)
returns timestamptz
language sql
stable
security definer
set search_path=''
as $$
  select (p_local_date+p_local_time) at time zone wf_private.organization_timezone(p_organization_id)
$$;

revoke all on function wf_private.organization_timezone(uuid),
  wf_private.organization_local_date(uuid,timestamptz),
  wf_private.organization_instant(uuid,date,time)
from public,anon,authenticated,service_role;

-- The close-out grace is part of the attendance policy. It must not be an
-- application constant because organizations with overnight or remote shifts
-- need different rollover windows.
alter table public.attendance_policies
  add column checkout_grace_minutes integer not null default 240
  check(checkout_grace_minutes between 0 and 1440);

-- ---------------------------------------------------------------------------
-- Stable, tenant-owned internal identities. Business codes remain available
-- during the compatibility window, but all new canonical relations use UUIDs.
-- ---------------------------------------------------------------------------
alter table public.employees
  add column internal_id uuid default extensions.gen_random_uuid(),
  add column employee_code text;
update public.employees
set internal_id=coalesce(internal_id,extensions.gen_random_uuid()),
    employee_code=coalesce(nullif(trim(employee_code),''),employee_id);
alter table public.employees
  alter column internal_id set not null,
  alter column employee_code set not null,
  add constraint employees_internal_id_key unique(internal_id),
  add constraint employees_organization_internal_key unique(organization_id,internal_id),
  add constraint employees_organization_identity_key unique(organization_id,internal_id,employee_id),
  add constraint employees_organization_code_key unique(organization_id,employee_code),
  add constraint employees_employee_code_format check(employee_code=trim(employee_code) and char_length(employee_code) between 1 and 80);

alter table public.locations
  add column internal_id uuid default extensions.gen_random_uuid(),
  add column location_code text;
update public.locations
set internal_id=coalesce(internal_id,extensions.gen_random_uuid()),
    location_code=coalesce(nullif(trim(location_code),''),center_id);
alter table public.locations
  alter column internal_id set not null,
  alter column location_code set not null,
  add constraint locations_internal_id_key unique(internal_id),
  add constraint locations_organization_internal_key unique(organization_id,internal_id),
  add constraint locations_organization_identity_key unique(organization_id,internal_id,center_id),
  add constraint locations_organization_code_key unique(organization_id,location_code);

alter table public.config_shifts
  add column internal_id uuid default extensions.gen_random_uuid();
update public.config_shifts set internal_id=coalesce(internal_id,extensions.gen_random_uuid());
alter table public.config_shifts
  alter column internal_id set not null,
  add constraint config_shifts_internal_id_key unique(internal_id),
  add constraint config_shifts_organization_internal_key unique(organization_id,internal_id),
  add constraint config_shifts_organization_identity_key unique(organization_id,internal_id,id);

-- Keep legacy import/Edge payloads compatible while the public contract moves
-- to UUID identities.  The business codes are always derived inside the
-- database, so callers cannot accidentally create an unaddressable row by
-- omitting the newly introduced columns.
create or replace function wf_private.assign_tenant_identity_defaults()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
begin
  if tg_table_name='employees' then
    new.internal_id:=coalesce(new.internal_id,extensions.gen_random_uuid());
    new.employee_code:=coalesce(nullif(trim(new.employee_code),''),new.employee_id);
  elsif tg_table_name='locations' then
    new.internal_id:=coalesce(new.internal_id,extensions.gen_random_uuid());
    new.location_code:=coalesce(nullif(trim(new.location_code),''),new.center_id);
  end if;
  return new;
end;
$$;
revoke all on function wf_private.assign_tenant_identity_defaults()
from public,anon,authenticated,service_role;

drop trigger if exists employees_assign_tenant_identity_defaults on public.employees;
create trigger employees_assign_tenant_identity_defaults
before insert or update of employee_id,employee_code,internal_id on public.employees
for each row execute function wf_private.assign_tenant_identity_defaults();

drop trigger if exists locations_assign_tenant_identity_defaults on public.locations;
create trigger locations_assign_tenant_identity_defaults
before insert or update of center_id,location_code,internal_id on public.locations
for each row execute function wf_private.assign_tenant_identity_defaults();

-- ---------------------------------------------------------------------------
-- Multiple published assignments per employee/day, including overnight shifts.
-- ---------------------------------------------------------------------------
alter table public.shift_assignments
  add column employee_internal_id uuid,
  add column shift_internal_id uuid,
  add column location_internal_id uuid,
  add column scheduled_start timestamptz,
  add column scheduled_end timestamptz;

with mapped as (
  select
    assignment.id,
    employee.internal_id as employee_internal_id,
    shift.internal_id as shift_internal_id,
    location.internal_id as location_internal_id,
    wf_private.organization_instant(
      assignment.organization_id,assignment.work_date,shift.start_time
    ) as scheduled_start,
    wf_private.organization_instant(
      assignment.organization_id,
      assignment.work_date+case when shift.end_time<=shift.start_time then 1 else 0 end,
      shift.end_time
    ) as scheduled_end
  from public.shift_assignments assignment
  join public.employees employee
    on employee.employee_id=assignment.employee_id
   and employee.organization_id=assignment.organization_id
  join public.config_shifts shift
    on shift.id=assignment.shift_id
   and shift.organization_id=assignment.organization_id
  left join public.locations location
    on location.center_id=assignment.location_id
   and location.organization_id=assignment.organization_id
)
update public.shift_assignments assignment
set employee_internal_id=mapped.employee_internal_id,
    shift_internal_id=mapped.shift_internal_id,
    location_internal_id=mapped.location_internal_id,
    scheduled_start=mapped.scheduled_start,
    scheduled_end=mapped.scheduled_end
from mapped
where assignment.id=mapped.id;

do $$
begin
  if exists(
    select 1 from public.shift_assignments
    where employee_internal_id is null or shift_internal_id is null
      or scheduled_start is null or scheduled_end is null
  ) then
    raise exception 'Không thể backfill UUID/cửa sổ thời gian cho lịch phân ca.';
  end if;
end;
$$;

alter table public.shift_assignments
  alter column employee_internal_id set not null,
  alter column shift_internal_id set not null,
  alter column scheduled_start set not null,
  alter column scheduled_end set not null,
  drop constraint if exists shift_assignments_employee_id_work_date_key,
  add constraint shift_assignments_organization_id_key unique(organization_id,id),
  add constraint shift_assignments_time_order check(scheduled_end>scheduled_start and scheduled_end-scheduled_start<=interval '24 hours'),
  add constraint shift_assignments_employee_internal_fk
    foreign key(organization_id,employee_internal_id)
    references public.employees(organization_id,internal_id) on delete cascade,
  add constraint shift_assignments_employee_identity_fk
    foreign key(organization_id,employee_internal_id,employee_id)
    references public.employees(organization_id,internal_id,employee_id) on delete cascade,
  add constraint shift_assignments_shift_internal_fk
    foreign key(organization_id,shift_internal_id)
    references public.config_shifts(organization_id,internal_id) on delete restrict,
  add constraint shift_assignments_shift_identity_fk
    foreign key(organization_id,shift_internal_id,shift_id)
    references public.config_shifts(organization_id,internal_id,id) on delete restrict,
  add constraint shift_assignments_location_internal_fk
    foreign key(organization_id,location_internal_id)
    references public.locations(organization_id,internal_id) on delete restrict,
  add constraint shift_assignments_location_identity_fk
    foreign key(organization_id,location_internal_id,location_id)
    references public.locations(organization_id,internal_id,center_id) on delete restrict,
  add constraint shift_assignments_location_identity_presence
    check((location_internal_id is null)=(location_id is null)),
  add constraint shift_assignments_tenant_window_key
    unique(organization_id,employee_internal_id,scheduled_start,scheduled_end);

create index shift_assignments_employee_window_idx
  on public.shift_assignments(organization_id,employee_internal_id,scheduled_start,scheduled_end)
  where publication_status='PUBLISHED';

create or replace function wf_private.materialize_assignment_window()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
declare
  employee public.employees%rowtype;
  shift public.config_shifts%rowtype;
  location public.locations%rowtype;
begin
  select * into employee from public.employees
  where employee_id=new.employee_id and organization_id=new.organization_id;
  select * into shift from public.config_shifts
  where id=new.shift_id and organization_id=new.organization_id;
  if employee.internal_id is null or shift.internal_id is null then
    raise exception 'Nhân viên hoặc ca không thuộc tổ chức.' using errcode='23503';
  end if;
  if new.location_id is not null then
    select * into location from public.locations
    where center_id=new.location_id and organization_id=new.organization_id;
    if location.internal_id is null then
      raise exception 'Địa điểm không thuộc tổ chức.' using errcode='23503';
    end if;
  end if;

  new.employee_internal_id:=employee.internal_id;
  new.shift_internal_id:=shift.internal_id;
  new.location_internal_id:=location.internal_id;
  new.scheduled_start:=wf_private.organization_instant(
    new.organization_id,new.work_date,shift.start_time
  );
  new.scheduled_end:=wf_private.organization_instant(
    new.organization_id,
    new.work_date+case when shift.end_time<=shift.start_time then 1 else 0 end,
    shift.end_time
  );
  perform pg_advisory_xact_lock(hashtextextended(
    'assignment-window:'||new.organization_id::text||':'||employee.internal_id::text,0
  ));
  if new.publication_status='PUBLISHED' and exists(
    select 1 from public.shift_assignments current_assignment
    where current_assignment.organization_id=new.organization_id
      and current_assignment.employee_internal_id=employee.internal_id
      and current_assignment.id<>new.id
      and current_assignment.publication_status='PUBLISHED'
      and tstzrange(current_assignment.scheduled_start,current_assignment.scheduled_end,'[)')
          && tstzrange(new.scheduled_start,new.scheduled_end,'[)')
  ) then
    raise exception 'Ca làm bị trùng thời gian với một ca đã công bố.' using errcode='23P01';
  end if;
  return new;
end;
$$;
revoke all on function wf_private.materialize_assignment_window()
from public,anon,authenticated,service_role;

drop trigger if exists shift_assignments_materialize_window on public.shift_assignments;
create trigger shift_assignments_materialize_window
before insert or update of employee_id,organization_id,shift_id,location_id,work_date,publication_status
on public.shift_assignments
for each row execute function wf_private.materialize_assignment_window();

-- ---------------------------------------------------------------------------
-- Canonical work sessions. A stale unfinished shift can move to NEEDS_REVIEW;
-- it no longer prevents a later valid shift from opening.
-- ---------------------------------------------------------------------------
create table public.work_sessions(
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  employee_internal_id uuid not null,
  employee_id text not null,
  assignment_id uuid,
  business_date date not null,
  session_sequence smallint not null check(session_sequence between 1 and 32),
  policy_id uuid,
  location_internal_id uuid,
  location_id text,
  expected_start timestamptz,
  expected_end timestamptz,
  actual_checkin timestamptz,
  actual_checkout timestamptz,
  status text not null default 'SCHEDULED'
    check(status in ('SCHEDULED','OPEN','COMPLETE','AUTO_APPROVED','NEEDS_REVIEW','PENDING_REVIEW','APPROVED','REJECTED','LOCKED','CANCELLED')),
  source text not null default 'NORMAL' check(source in ('NORMAL','ADJUSTED','LEGACY','IMPORT')),
  exception_codes text[] not null default '{}',
  break_started_at timestamptz,
  break_minutes integer not null default 0 check(break_minutes>=0),
  late_minutes integer not null default 0 check(late_minutes>=0),
  early_minutes integer not null default 0 check(early_minutes>=0),
  work_minutes integer not null default 0 check(work_minutes>=0),
  revision bigint not null default 1,
  locked_at timestamptz,
  locked_by text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint work_sessions_employee_internal_fk
    foreign key(organization_id,employee_internal_id)
    references public.employees(organization_id,internal_id) on delete restrict,
  constraint work_sessions_employee_identity_fk
    foreign key(organization_id,employee_internal_id,employee_id)
    references public.employees(organization_id,internal_id,employee_id) on delete restrict,
  constraint work_sessions_assignment_fk
    foreign key(organization_id,assignment_id)
    references public.shift_assignments(organization_id,id) on delete restrict,
  constraint work_sessions_policy_fk
    foreign key(organization_id,policy_id)
    references public.attendance_policies(organization_id,id) on delete restrict,
  constraint work_sessions_location_internal_fk
    foreign key(organization_id,location_internal_id)
    references public.locations(organization_id,internal_id) on delete restrict,
  constraint work_sessions_location_identity_fk
    foreign key(organization_id,location_internal_id,location_id)
    references public.locations(organization_id,internal_id,center_id) on delete restrict,
  constraint work_sessions_location_identity_presence
    check((location_internal_id is null)=(location_id is null)),
  constraint work_sessions_actual_order
    check(actual_checkout is null or (actual_checkin is not null and actual_checkout>=actual_checkin)),
  constraint work_sessions_expected_order
    check(expected_end is null or (expected_start is not null and expected_end>expected_start)),
  constraint work_sessions_organization_id_key unique(organization_id,id),
  constraint work_sessions_day_sequence_key
    unique(organization_id,employee_internal_id,business_date,session_sequence)
    deferrable initially deferred
);

create unique index work_sessions_assignment_key
  on public.work_sessions(organization_id,assignment_id)
  where assignment_id is not null;
create unique index work_sessions_one_live_session
  on public.work_sessions(organization_id,employee_internal_id,business_date)
  where status='OPEN';
create index work_sessions_employee_history_idx
  on public.work_sessions(organization_id,employee_internal_id,business_date desc,session_sequence desc);
create index work_sessions_active_idx
  on public.work_sessions(organization_id,employee_internal_id,actual_checkin desc)
  where actual_checkin is not null and actual_checkout is null and status='OPEN';
create index work_sessions_payroll_idx
  on public.work_sessions(organization_id,business_date,status,employee_internal_id);

alter table public.work_sessions enable row level security;
revoke all on table public.work_sessions
from public,anon,authenticated,service_role;

create trigger work_sessions_revision
before update on public.work_sessions
for each row execute function wf_private.bump_revision();

insert into public.work_sessions(
  id,organization_id,employee_internal_id,employee_id,assignment_id,
  business_date,session_sequence,policy_id,location_internal_id,location_id,
  expected_start,expected_end,actual_checkin,actual_checkout,status,source,
  exception_codes,break_started_at,break_minutes,late_minutes,early_minutes,
  work_minutes,revision,locked_at,locked_by,created_at,updated_at
)
select
  timesheet.id,timesheet.organization_id,employee.internal_id,timesheet.employee_id,
  assignment.id,timesheet.work_date,1,timesheet.policy_id,location.internal_id,
  case when location.internal_id is null then null else timesheet.location_id end,
  timesheet.expected_start,timesheet.expected_end,
  timesheet.actual_checkin,timesheet.actual_checkout,
  case timesheet.status
    when 'EXCEPTION' then 'NEEDS_REVIEW'
    else timesheet.status
  end,
  case when timesheet.source='LEGACY' then 'LEGACY' when timesheet.source='ADJUSTED' then 'ADJUSTED' else 'NORMAL' end,
  timesheet.exception_codes,timesheet.break_started_at,timesheet.break_minutes,
  timesheet.late_minutes,timesheet.early_minutes,timesheet.work_minutes,
  timesheet.revision,timesheet.locked_at,timesheet.locked_by,
  timesheet.created_at,timesheet.updated_at
from public.timesheets timesheet
join public.employees employee
  on employee.employee_id=timesheet.employee_id
 and employee.organization_id=timesheet.organization_id
left join lateral(
  select candidate.id
  from public.shift_assignments candidate
  where candidate.organization_id=timesheet.organization_id
    and candidate.employee_internal_id=employee.internal_id
    and candidate.work_date=timesheet.work_date
    and candidate.publication_status='PUBLISHED'
    and candidate.scheduled_start is not distinct from timesheet.expected_start
    and candidate.scheduled_end is not distinct from timesheet.expected_end
  order by candidate.id
  limit 1
) assignment on true
left join public.locations location
  on location.organization_id=timesheet.organization_id
 and location.center_id=timesheet.location_id
on conflict(id) do nothing;

alter table public.attendance_events add column work_session_id uuid;
alter table public.attendance_requests add column work_session_id uuid;
alter table public.workforce_receipts add column work_session_id uuid;

-- attendance_events carries a blanket immutability trigger so that no runtime path
-- can ever rewrite raw evidence. Filling the new foreign key is a one-time
-- structural backfill, not a correction of what was recorded, so the guard is
-- lifted for exactly this statement and restored immediately. DDL is transactional
-- here: if anything later in the migration fails, the rollback brings the enabled
-- trigger back together with the column itself.
alter table public.attendance_events disable trigger attendance_events_immutable;
update public.attendance_events event
set work_session_id=session.id
from public.work_sessions session
where event.work_session_id is null and event.timesheet_id=session.id;
alter table public.attendance_events enable trigger attendance_events_immutable;
update public.attendance_requests request
set work_session_id=session.id
from public.work_sessions session
where request.work_session_id is null and request.timesheet_id=session.id;
update public.workforce_receipts receipt
set work_session_id=(receipt.payload->'receipt'->>'timesheet_id')::uuid
where receipt.work_session_id is null
  and nullif(receipt.payload->'receipt'->>'timesheet_id','') is not null
  and receipt.payload->'receipt'->>'timesheet_id'
    ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  and exists(
    select 1 from public.work_sessions session
    where session.id=(receipt.payload->'receipt'->>'timesheet_id')::uuid
  );

alter table public.attendance_events
  add constraint attendance_events_work_session_fk
  foreign key(organization_id,work_session_id)
  references public.work_sessions(organization_id,id) on delete restrict;
alter table public.attendance_requests
  add constraint attendance_requests_work_session_fk
  foreign key(organization_id,work_session_id)
  references public.work_sessions(organization_id,id) on delete restrict;
alter table public.workforce_receipts
  add constraint workforce_receipts_work_session_fk
  foreign key(organization_id,work_session_id)
  references public.work_sessions(organization_id,id) on delete restrict;
create index attendance_events_work_session_idx on public.attendance_events(work_session_id,occurred_at);
create index attendance_requests_work_session_idx on public.attendance_requests(work_session_id,created_at desc);

create or replace function wf_private.guard_assignment_session_lifecycle()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
declare
  linked_session public.work_sessions%rowtype;
begin
  select * into linked_session
  from public.work_sessions session
  where session.organization_id=old.organization_id
    and session.assignment_id=old.id
  for update;

  if linked_session.actual_checkin is not null and tg_op='DELETE' then
    raise exception 'Ca đã có dữ liệu chấm công; chỉ được sửa ghi chú.' using errcode='55000';
  end if;

  if linked_session.actual_checkin is not null and tg_op='UPDATE' and (
    new.organization_id is distinct from old.organization_id
    or new.employee_id is distinct from old.employee_id
    or new.work_date is distinct from old.work_date
    or new.shift_id is distinct from old.shift_id
    or new.location_id is distinct from old.location_id
    or new.publication_status is distinct from old.publication_status
  ) then
    raise exception 'Ca đã có dữ liệu chấm công; chỉ được sửa ghi chú.' using errcode='55000';
  end if;

  if linked_session.id is not null
    and linked_session.actual_checkin is null
    and tg_op='DELETE' then
    delete from public.work_sessions session where session.id=linked_session.id;
  end if;
  if linked_session.id is not null
    and linked_session.actual_checkin is null
    and tg_op='UPDATE'
    and new.publication_status<>'PUBLISHED' then
    delete from public.work_sessions session where session.id=linked_session.id;
  end if;
  return case when tg_op='DELETE' then old else new end;
end;
$$;
revoke all on function wf_private.guard_assignment_session_lifecycle()
from public,anon,authenticated,service_role;

drop trigger if exists shift_assignments_guard_session_lifecycle on public.shift_assignments;
create trigger shift_assignments_guard_session_lifecycle
before update or delete on public.shift_assignments
for each row execute function wf_private.guard_assignment_session_lifecycle();

create or replace function wf_private.resequence_work_sessions(
  p_organization_id uuid,
  p_employee_internal_id uuid,
  p_business_date date
)
returns void
language sql
security definer
set search_path=''
as $$
  with ranked as (
    select
      session.id,
      row_number() over(
        order by coalesce(session.expected_start,session.created_at),session.id
      )::smallint as next_sequence
    from public.work_sessions session
    where session.organization_id=p_organization_id
      and session.employee_internal_id=p_employee_internal_id
      and session.business_date=p_business_date
  )
  update public.work_sessions session
  set session_sequence=ranked.next_sequence
  from ranked
  where session.id=ranked.id
    and session.session_sequence<>ranked.next_sequence
$$;
revoke all on function wf_private.resequence_work_sessions(uuid,uuid,date)
from public,anon,authenticated,service_role;

create or replace function wf_private.sync_published_assignment_session()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
declare
  employee public.employees%rowtype;
  location public.locations%rowtype;
  linked_session public.work_sessions%rowtype;
  sequence_number smallint;
begin
  if tg_op='DELETE' then
    perform wf_private.resequence_work_sessions(
      old.organization_id,old.employee_internal_id,old.work_date
    );
    update public.timesheets day_sheet
    set expected_start=day_sheet.expected_start,
        expected_end=day_sheet.expected_end
    where day_sheet.organization_id=old.organization_id
      and day_sheet.employee_id=old.employee_id
      and day_sheet.work_date=old.work_date
      and day_sheet.status<>'LOCKED';
    return old;
  end if;
  if new.publication_status<>'PUBLISHED' then
    perform wf_private.resequence_work_sessions(
      old.organization_id,old.employee_internal_id,old.work_date
    );
    update public.timesheets day_sheet
    set expected_start=day_sheet.expected_start,
        expected_end=day_sheet.expected_end
    where day_sheet.organization_id=old.organization_id
      and day_sheet.employee_id=old.employee_id
      and day_sheet.work_date=old.work_date
      and day_sheet.status<>'LOCKED';
    return new;
  end if;
  select * into employee from public.employees
  where organization_id=new.organization_id and internal_id=new.employee_internal_id;
  if new.location_internal_id is not null then
    select * into location from public.locations
    where organization_id=new.organization_id and internal_id=new.location_internal_id;
  else
    select * into location from public.locations
    where organization_id=new.organization_id and center_id=employee.center_id;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'work-session-sequence:'||new.organization_id::text||':'||new.employee_internal_id::text||':'||new.work_date::text,0
  ));
  select * into linked_session
  from public.work_sessions session
  where session.organization_id=new.organization_id
    and session.assignment_id=new.id
  for update;
  if linked_session.id is null then
    perform wf_private.resequence_work_sessions(
      new.organization_id,new.employee_internal_id,new.work_date
    );
    select count(*)+1 into sequence_number
    from public.work_sessions session
    where session.organization_id=new.organization_id
      and session.employee_internal_id=new.employee_internal_id
      and session.business_date=new.work_date;
    if sequence_number>32 then
      raise exception 'Vượt giới hạn số ca trong ngày.' using errcode='54000';
    end if;
    insert into public.work_sessions(
      organization_id,employee_internal_id,employee_id,assignment_id,business_date,
      session_sequence,policy_id,location_internal_id,location_id,expected_start,
      expected_end,status,source
    ) values(
      new.organization_id,new.employee_internal_id,new.employee_id,new.id,new.work_date,
      sequence_number,employee.attendance_policy_id,location.internal_id,
      coalesce(new.location_id,employee.center_id),new.scheduled_start,new.scheduled_end,
      'SCHEDULED','NORMAL'
    );
  else
    if linked_session.actual_checkin is not null then
      if tg_op='UPDATE' and (
        new.organization_id,new.employee_internal_id,new.employee_id,
        new.work_date,new.location_internal_id,new.location_id,
        new.scheduled_start,new.scheduled_end,new.publication_status
      ) is not distinct from (
        old.organization_id,old.employee_internal_id,old.employee_id,
        old.work_date,old.location_internal_id,old.location_id,
        old.scheduled_start,old.scheduled_end,old.publication_status
      ) then
        -- The migration seed and metadata-only edits are semantic no-ops for
        -- attendance evidence; keep the already-linked session unchanged.
        return new;
      end if;
      raise exception 'Ca đã có dữ liệu chấm công; không thể thay đổi cửa sổ lịch.'
        using errcode='55000';
    end if;
    perform wf_private.resequence_work_sessions(
      new.organization_id,new.employee_internal_id,new.work_date
    );
    select count(*)+1 into sequence_number
    from public.work_sessions session
    where session.organization_id=new.organization_id
      and session.employee_internal_id=new.employee_internal_id
      and session.business_date=new.work_date
      and session.id<>linked_session.id;
    if sequence_number>32 then
      raise exception 'Vượt giới hạn số ca trong ngày.' using errcode='54000';
    end if;
    update public.work_sessions session
    set employee_internal_id=new.employee_internal_id,
        employee_id=new.employee_id,
        business_date=new.work_date,
        session_sequence=sequence_number,
        policy_id=employee.attendance_policy_id,
        location_internal_id=location.internal_id,
        location_id=coalesce(new.location_id,employee.center_id),
        expected_start=new.scheduled_start,
        expected_end=new.scheduled_end,
        status='SCHEDULED',
        updated_at=clock_timestamp()
    where session.id=linked_session.id;
    if old.organization_id is distinct from new.organization_id
      or old.employee_internal_id is distinct from new.employee_internal_id
      or old.work_date is distinct from new.work_date then
      perform wf_private.resequence_work_sessions(
        old.organization_id,old.employee_internal_id,old.work_date
      );
    end if;
  end if;
  perform wf_private.resequence_work_sessions(
    new.organization_id,new.employee_internal_id,new.work_date
  );
  update public.timesheets day_sheet
  set expected_start=day_sheet.expected_start,
      expected_end=day_sheet.expected_end
  where day_sheet.organization_id=new.organization_id
    and day_sheet.employee_id=new.employee_id
    and day_sheet.work_date=new.work_date
    and day_sheet.status<>'LOCKED';
  return new;
end;
$$;
revoke all on function wf_private.sync_published_assignment_session()
from public,anon,authenticated,service_role;

drop trigger if exists shift_assignments_sync_session on public.shift_assignments;
create trigger shift_assignments_sync_session
after insert or update or delete
on public.shift_assignments
for each row execute function wf_private.sync_published_assignment_session();

-- Seed scheduled sessions for assignments that were already published.
-- Insert directly instead of issuing a no-op assignment UPDATE: the latter
-- bumps every assignment revision and invalidates pending shift-swap evidence.
with missing as (
  select assignment.organization_id,assignment.id as assignment_id,
    assignment.employee_internal_id,assignment.employee_id,assignment.work_date,
    employee.attendance_policy_id,
    coalesce(assignment.location_internal_id,home_location.internal_id)
      as effective_location_internal_id,
    case when coalesce(assignment.location_internal_id,home_location.internal_id) is null
      then null else coalesce(assignment.location_id,employee.center_id) end
      as effective_location_id,
    assignment.scheduled_start,assignment.scheduled_end
  from public.shift_assignments assignment
  join public.employees employee
    on employee.organization_id=assignment.organization_id
   and employee.internal_id=assignment.employee_internal_id
  left join public.locations home_location
    on home_location.organization_id=employee.organization_id
   and home_location.center_id=employee.center_id
  where assignment.publication_status='PUBLISHED'
    and not exists(
      select 1 from public.work_sessions linked
      where linked.organization_id=assignment.organization_id
        and linked.assignment_id=assignment.id
    )
), numbered as (
  select missing.*,
    (
      coalesce((
        select max(existing.session_sequence)
        from public.work_sessions existing
        where existing.organization_id=missing.organization_id
          and existing.employee_internal_id=missing.employee_internal_id
          and existing.business_date=missing.work_date
      ),0)
      +row_number() over(
        partition by missing.organization_id,missing.employee_internal_id,missing.work_date
        order by missing.scheduled_start,missing.assignment_id
      )
    )::smallint as session_sequence
  from missing
)
insert into public.work_sessions(
  organization_id,employee_internal_id,employee_id,assignment_id,business_date,
  session_sequence,policy_id,location_internal_id,location_id,expected_start,
  expected_end,status,source
)
select organization_id,employee_internal_id,employee_id,assignment_id,work_date,
  session_sequence,attendance_policy_id,effective_location_internal_id,
  effective_location_id,scheduled_start,scheduled_end,'SCHEDULED','NORMAL'
from numbered;

-- The legacy day aggregate trigger must tolerate multiple assignments and use
-- the tenant timezone. It intentionally chooses the earliest shift of the day.
create or replace function tms_private.apply_assigned_shift_to_timesheet()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
declare
  first_start timestamptz;
  last_end timestamptz;
  first_location text;
  employee public.employees%rowtype;
  policy public.attendance_policies%rowtype;
begin
  select
    min(candidate.scheduled_start),
    max(candidate.scheduled_end),
    (array_agg(candidate.location_id order by candidate.scheduled_start,candidate.id))[1]
  into first_start,last_end,first_location
  from public.shift_assignments candidate
  where candidate.organization_id=new.organization_id
    and candidate.employee_id=new.employee_id
    and candidate.work_date=new.work_date
    and candidate.publication_status='PUBLISHED';
  if first_start is not null then
    new.expected_start:=first_start;
    new.expected_end:=last_end;
    new.location_id:=coalesce(first_location,new.location_id);
  else
    select * into employee from public.employees candidate
    where candidate.organization_id=new.organization_id
      and candidate.employee_id=new.employee_id;
    select * into policy from public.attendance_policies candidate
    where candidate.organization_id=new.organization_id
      and candidate.id=employee.attendance_policy_id;
    if policy.id is not null then
      new.expected_start:=wf_private.organization_instant(
        new.organization_id,new.work_date,policy.expected_start
      );
      new.expected_end:=wf_private.organization_instant(
        new.organization_id,
        new.work_date+case when policy.expected_end<=policy.expected_start then 1 else 0 end,
        policy.expected_end
      );
      new.location_id:=coalesce(employee.center_id,new.location_id);
    end if;
  end if;
  return new;
end;
$$;
revoke all on function tms_private.apply_assigned_shift_to_timesheet()
from public,anon,authenticated,service_role;

-- Existing day aggregates are historical evidence. They are intentionally not
-- rewritten merely to fire the new trigger; future writes use it naturally.

-- ---------------------------------------------------------------------------
-- Durable attendance command ledger. Only canonical hashes are retained; raw
-- QR payloads and coordinates never enter this ledger.
-- ---------------------------------------------------------------------------
create table public.attendance_commands(
  organization_id uuid not null references public.organizations(id) on delete restrict,
  employee_internal_id uuid not null,
  command_id uuid not null,
  action text not null check(action in ('checkin','checkout','pause','resume')),
  request_hash text not null check(request_hash ~ '^[0-9a-f]{64}$'),
  state text not null default 'PROCESSING' check(state in ('PROCESSING','COMPLETED','FAILED')),
  response jsonb,
  created_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  primary key(organization_id,employee_internal_id,command_id),
  foreign key(organization_id,employee_internal_id)
    references public.employees(organization_id,internal_id) on delete restrict
);
create index attendance_commands_cleanup_idx
  on public.attendance_commands(created_at)
  where state in ('COMPLETED','FAILED');
alter table public.attendance_commands enable row level security;
revoke all on table public.attendance_commands
from public,anon,authenticated,service_role;

create or replace function wf_private.finish_attendance_command(
  p_organization_id uuid,
  p_employee_internal_id uuid,
  p_command_id uuid,
  p_response jsonb,
  p_state text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
begin
  update public.attendance_commands
  set state=p_state,response=p_response,completed_at=clock_timestamp()
  where organization_id=p_organization_id
    and employee_internal_id=p_employee_internal_id
    and command_id=p_command_id;
  return p_response;
end;
$$;
revoke all on function wf_private.finish_attendance_command(uuid,uuid,uuid,jsonb,text)
from public,anon,authenticated,service_role;

create or replace function wf_private.attendance(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  actor public.employees%rowtype;
  policy public.attendance_policies%rowtype;
  location public.locations%rowtype;
  assignment public.shift_assignments%rowtype;
  work_session public.work_sessions%rowtype;
  day_sheet public.timesheets%rowtype;
  qr_session public.attendance_qr_sessions%rowtype;
  existing_command public.attendance_commands%rowtype;
  v_command_id uuid;
  action text:=p->>'action';
  v_device_id text:=p->>'device_id';
  qr jsonb;
  latitude double precision:=(p->>'lat')::double precision;
  longitude double precision:=(p->>'lng')::double precision;
  accuracy double precision:=(p->>'accuracy')::double precision;
  distance double precision;
  now_at timestamptz:=clock_timestamp();
  local_date date;
  v_business_date date;
  expected_start_at timestamptz;
  expected_end_at timestamptz;
  v_late_minutes integer:=0;
  v_early_minutes integer:=0;
  gross_minutes integer:=0;
  unpaid_minutes integer:=0;
  device_ok boolean:=false;
  codes text[]:='{}'::text[];
  event_id uuid;
  event_kind text;
  receipt_id uuid:=extensions.gen_random_uuid();
  result jsonb;
  failure jsonb;
  site text;
  next_sequence smallint;
  payload_hash text;
  aggregate_status text;
  stale_session_id uuid;
  stale_business_date date;
  active_session_id uuid;
begin
  actor:=wf_private.require_capability('attendance.self');
  begin
    v_command_id:=(p->>'command_id')::uuid;
  exception when others then
    raise exception 'Mã lệnh chấm công không hợp lệ.' using errcode='22023';
  end;
  if v_command_id is null or action not in ('checkin','checkout','pause','resume') then
    raise exception 'Lệnh chấm công không hợp lệ.' using errcode='22023';
  end if;

  payload_hash:=encode(extensions.digest(convert_to(
    jsonb_build_object(
      'action',action,
      'device_id',coalesce(v_device_id,''),
      'qr_hash',encode(extensions.digest(convert_to(coalesce(p->>'qr_payload',''),'UTF8'),'sha256'),'hex'),
      'latitude_4dp',case when latitude is null then null else round(latitude::numeric,4) end,
      'longitude_4dp',case when longitude is null then null else round(longitude::numeric,4) end,
      'accuracy_bucket',case when accuracy is null then null else ceil(accuracy/5)*5 end
    )::text,'UTF8'
  ),'sha256'),'hex');

  perform pg_advisory_xact_lock(hashtextextended(
    'attendance-command:'||actor.organization_id::text||':'||actor.internal_id::text||':'||v_command_id::text,0
  ));
  select * into existing_command
  from public.attendance_commands command
  where command.organization_id=actor.organization_id
    and command.employee_internal_id=actor.internal_id
    and command.command_id=v_command_id;
  if found then
    if existing_command.action<>action or existing_command.request_hash<>payload_hash then
      raise exception 'Mã lệnh đã được dùng cho nội dung khác.' using errcode='22023';
    end if;
    if existing_command.response is not null then return existing_command.response; end if;
  else
    insert into public.attendance_commands(
      organization_id,employee_internal_id,command_id,action,request_hash
    ) values(
      actor.organization_id,actor.internal_id,v_command_id,action,payload_hash
    );
  end if;

  -- Per-employee serialization makes check-in, checkout and stale-session
  -- rollover deterministic even under double taps or concurrent devices.
  perform pg_advisory_xact_lock(hashtextextended(
    'workforce:'||actor.organization_id::text||':'||actor.internal_id::text,0
  ));

  -- Pin a single tenant configuration revision before reading policy,
  -- timezone, device and geofence data. The config writer takes the matching
  -- exclusive lock, so one punch can never mix two committed revisions.
  perform pg_advisory_xact_lock_shared(hashtextextended(
    'workforce-config:'||actor.organization_id::text,0
  ));

  select * into policy from public.attendance_policies
  where id=actor.attendance_policy_id
    and organization_id=actor.organization_id and active;
  if not found then
    failure:=wf_private.failure('POLICY_MISSING','Chưa có chính sách chấm công. Liên hệ quản lý.');
    return wf_private.finish_attendance_command(actor.organization_id,actor.internal_id,v_command_id,failure,'FAILED');
  end if;

  device_ok:=exists(
    select 1
    from public.trusted_device_grants device_grant
    join public.trusted_devices device
      on device.device_id=device_grant.device_id
     and device.employee_id=device_grant.employee_id
    where device_grant.employee_id=actor.employee_id
      and device_grant.device_id=v_device_id
      and device_grant.expires_at>now_at
      and device.status='ACTIVE'
      and device.organization_id=actor.organization_id
  );
  if not device_ok then
    failure:=wf_private.failure('DEVICE_NOT_VERIFIED','Thiết bị chưa được xác thực. Đăng nhập lại hoặc liên hệ quản trị.');
    return wf_private.finish_attendance_command(actor.organization_id,actor.internal_id,v_command_id,failure,'FAILED');
  end if;
  if latitude is null or longitude is null or latitude not between -90 and 90
    or longitude not between -180 and 180 or accuracy is null
    or accuracy not between 0.1 and 10000 then
    failure:=wf_private.failure('GPS_INVALID','Dữ liệu vị trí không hợp lệ. Bật quyền vị trí chính xác.');
    return wf_private.finish_attendance_command(actor.organization_id,actor.internal_id,v_command_id,failure,'FAILED');
  end if;
  if accuracy>policy.gps_good_accuracy_m then
    failure:=wf_private.failure(
      case when accuracy>policy.gps_max_accuracy_m then 'GPS_ACCURACY' else 'GPS_UNCERTAIN' end,
      'GPS chưa đủ chính xác. Giữ máy ổn định ở nơi thoáng và thử lại.',
      jsonb_build_object('accuracy',accuracy,'required_accuracy',policy.gps_good_accuracy_m)
    );
    return wf_private.finish_attendance_command(actor.organization_id,actor.internal_id,v_command_id,failure,'FAILED');
  end if;

  local_date:=wf_private.organization_local_date(actor.organization_id,now_at);
  if action='checkin' then
    begin qr:=(p->>'qr_payload')::jsonb;
    exception when others then
      failure:=wf_private.failure('QR_INVALID','Mã QR không đúng định dạng.');
      return wf_private.finish_attendance_command(actor.organization_id,actor.internal_id,v_command_id,failure,'FAILED');
    end;
    if qr is null or qr->>'v'<>'1' then
      failure:=wf_private.failure('QR_INVALID','Quét mã tại trạm làm việc.');
      return wf_private.finish_attendance_command(actor.organization_id,actor.internal_id,v_command_id,failure,'FAILED');
    end if;
    begin
      select * into qr_session from public.attendance_qr_sessions
      where station_user_id=(qr->>'s')::uuid;
    exception when others then
      failure:=wf_private.failure('QR_INVALID','Mã QR không hợp lệ.');
      return wf_private.finish_attendance_command(actor.organization_id,actor.internal_id,v_command_id,failure,'FAILED');
    end;
    if qr_session.station_user_id is null or qr_session.expires_at<=now_at
      or qr_session.center_id is distinct from qr->>'c'
      or qr_session.token_hash is distinct from encode(
        extensions.digest(coalesce(qr->>'t',''),'sha256'),'hex'
      )
      or not exists(
        select 1 from public.qr_stations station
        where station.station_user_id=qr_session.station_user_id
          and station.active and station.organization_id=actor.organization_id
      ) then
      failure:=wf_private.failure('QR_EXPIRED','Mã QR đã đổi hoặc hết hạn. Quét lại mã mới.');
      return wf_private.finish_attendance_command(actor.organization_id,actor.internal_id,v_command_id,failure,'FAILED');
    end if;
    site:=qr_session.center_id;

    -- Select the nearest unmatched published assignment. The previous local
    -- date is included so an overnight shift remains attributable after 00:00.
    select candidate.* into assignment
    from public.shift_assignments candidate
    where candidate.organization_id=actor.organization_id
      and candidate.employee_internal_id=actor.internal_id
      and candidate.publication_status='PUBLISHED'
      and candidate.scheduled_start<=now_at+interval '4 hours'
      and candidate.scheduled_end>=now_at-interval '4 hours'
      and not exists(
        select 1 from public.work_sessions linked
        where linked.organization_id=actor.organization_id
          and linked.assignment_id=candidate.id
          and linked.actual_checkin is not null
      )
    order by abs(extract(epoch from(now_at-candidate.scheduled_start))),candidate.id
    limit 1
    for update;

    v_business_date:=coalesce(assignment.work_date,local_date);
    expected_start_at:=coalesce(
      assignment.scheduled_start,
      wf_private.organization_instant(actor.organization_id,v_business_date,policy.expected_start)
    );
    expected_end_at:=coalesce(
      assignment.scheduled_end,
      wf_private.organization_instant(
        actor.organization_id,
        v_business_date+case when policy.expected_end<=policy.expected_start then 1 else 0 end,
        policy.expected_end
      )
    );

    if site<>actor.center_id and not(site=any(coalesce(actor.allowed_locations,'{}')))
      and site is distinct from assignment.location_id then
      failure:=wf_private.failure('LOCATION_NOT_ALLOWED','Bạn không được phân công tại địa điểm này.');
      return wf_private.finish_attendance_command(actor.organization_id,actor.internal_id,v_command_id,failure,'FAILED');
    end if;
    select * into location from public.locations
    where center_id=site and active and organization_id=actor.organization_id;
    if not found then
      failure:=wf_private.failure('LOCATION_MISSING','Địa điểm chưa được cấu hình.');
      return wf_private.finish_attendance_command(actor.organization_id,actor.internal_id,v_command_id,failure,'FAILED');
    end if;
    distance:=tms_private.distance_meters(latitude,longitude,location.latitude,location.longitude);
    if distance>location.radius_meters then
      failure:=wf_private.failure(
        'OUTSIDE_GEOFENCE','Bạn đang ở ngoài phạm vi chấm công.',
        jsonb_build_object('distance',round(distance::numeric),'radius',location.radius_meters)
      );
      return wf_private.finish_attendance_command(actor.organization_id,actor.internal_id,v_command_id,failure,'FAILED');
    end if;
    -- Discover a rollover candidate without a row lock, then acquire every
    -- affected payroll-month lock in chronological order. Payroll close uses
    -- the same order, avoiding a new-month -> old-month deadlock at month end.
    select stale.id,stale.business_date
    into stale_session_id,stale_business_date
    from public.work_sessions stale
    left join public.attendance_policies stale_policy
      on stale_policy.organization_id=stale.organization_id
     and stale_policy.id=stale.policy_id
    where stale.organization_id=actor.organization_id
      and stale.employee_internal_id=actor.internal_id
      and stale.status='OPEN'
      and (
        stale.business_date<>v_business_date
        or (
          assignment.id is not null
          and stale.assignment_id is distinct from assignment.id
          and now_at>=expected_start_at
        )
        or coalesce(stale.expected_end,stale.actual_checkin+interval '24 hours')
          +make_interval(mins=>coalesce(
            stale_policy.checkout_grace_minutes,policy.checkout_grace_minutes
          ))<now_at
      )
    order by stale.actual_checkin
    limit 1;

    if stale_business_date is null then
      perform wf_private.period_lock(
        actor.organization_id,v_business_date,v_business_date,false
      );
    elsif stale_business_date<=v_business_date then
      perform wf_private.period_lock(
        actor.organization_id,stale_business_date,stale_business_date,false
      );
      if stale_business_date<>v_business_date then
        perform wf_private.period_lock(
          actor.organization_id,v_business_date,v_business_date,false
        );
      end if;
    else
      perform wf_private.period_lock(
        actor.organization_id,v_business_date,v_business_date,false
      );
      perform wf_private.period_lock(
        actor.organization_id,stale_business_date,stale_business_date,false
      );
    end if;
    if exists(
      select 1 from public.attendance_periods period
      where period.organization_id=actor.organization_id and period.status='CLOSED'
        and v_business_date between period.period_start and period.period_end
    ) or exists(
      select 1 from public.timesheets locked_sheet
      where locked_sheet.organization_id=actor.organization_id
        and locked_sheet.employee_id=actor.employee_id
        and locked_sheet.work_date=v_business_date
        and locked_sheet.status='LOCKED'
    ) then
      failure:=wf_private.failure('PERIOD_LOCKED','Kỳ công đã khóa. Liên hệ HR để xử lý có kiểm soát.');
      return wf_private.finish_attendance_command(actor.organization_id,actor.internal_id,v_command_id,failure,'FAILED');
    end if;

    -- Re-lock and revalidate the candidate after joining the period protocol.
    -- Validate the old period before changing evidence so a failed check-in can
    -- never partially mutate a closed payroll period.
    work_session:=null;
    select stale.* into work_session
    from public.work_sessions stale
    left join public.attendance_policies stale_policy
      on stale_policy.organization_id=stale.organization_id
     and stale_policy.id=stale.policy_id
    where stale.organization_id=actor.organization_id
      and stale.employee_internal_id=actor.internal_id
      and stale.id=stale_session_id
      and stale.status='OPEN'
      and (
        -- An unfinished session from another business day must never block a
        -- valid new check-in, even while its old checkout grace is running.
        stale.business_date<>v_business_date
        -- The next published assignment may start immediately after the prior
        -- shift. At that point the missed checkout becomes reviewable instead
        -- of blocking the employee for the whole grace window.
        or (
          assignment.id is not null
          and stale.assignment_id is distinct from assignment.id
          and now_at>=expected_start_at
        )
        or coalesce(stale.expected_end,stale.actual_checkin+interval '24 hours')
          +make_interval(mins=>coalesce(
            stale_policy.checkout_grace_minutes,policy.checkout_grace_minutes
          ))<now_at
      )
    for update of stale;
    if work_session.id is not null then
      if exists(
        select 1 from public.attendance_periods period
        where period.organization_id=actor.organization_id
          and period.status='CLOSED'
          and work_session.business_date between period.period_start and period.period_end
      ) or exists(
        select 1 from public.timesheets locked_sheet
        where locked_sheet.organization_id=actor.organization_id
          and locked_sheet.employee_id=actor.employee_id
          and locked_sheet.work_date=work_session.business_date
        and locked_sheet.status='LOCKED'
      ) then
        -- The closed period is immutable. Preserve the historical OPEN row as
        -- evidence, but do not let it block a new business day's session.
        work_session:=null;
      else
        update public.work_sessions stale
        set status='NEEDS_REVIEW',
            exception_codes=array(
              select distinct code
              from unnest(coalesce(stale.exception_codes,'{}')||array[
                'MISSING_CHECKOUT','SUPERSEDED_BY_NEW_CHECKIN'
              ]) code
            ),
            break_minutes=stale.break_minutes+case
              when stale.break_started_at is null then 0
              else greatest(0,floor(extract(epoch from(now_at-stale.break_started_at))/60)::integer)
            end,
            break_started_at=null
        where stale.id=work_session.id;
        update public.timesheets stale_sheet
        set status='EXCEPTION',
            exception_codes=array(
              select distinct code
              from unnest(coalesce(stale_sheet.exception_codes,'{}')||array[
                'MISSING_CHECKOUT','SUPERSEDED_BY_NEW_CHECKIN'
              ]) code
            )
        where stale_sheet.organization_id=actor.organization_id
          and stale_sheet.employee_id=actor.employee_id
          and stale_sheet.work_date=work_session.business_date
          and stale_sheet.status<>'LOCKED';
      end if;
    end if;

    work_session:=null;
    select * into work_session from public.work_sessions current_session
    where current_session.organization_id=actor.organization_id
      and current_session.employee_internal_id=actor.internal_id
      and current_session.business_date=v_business_date
      and current_session.status='OPEN'
    limit 1 for update;
    if found then
      failure:=wf_private.failure('ALREADY_OPEN','Bạn đang có một ca còn hiệu lực. Hãy check-out ca đó trước.');
      return wf_private.finish_attendance_command(actor.organization_id,actor.internal_id,v_command_id,failure,'FAILED');
    end if;

    if now_at>expected_start_at+make_interval(mins=>policy.late_tolerance_minutes) then
      v_late_minutes:=floor(extract(epoch from(now_at-expected_start_at))/60)::integer;
      codes:=array_append(codes,'LATE');
    end if;
    if assignment.id is null
      and not(extract(isodow from v_business_date)::smallint=any(policy.work_days)) then
      codes:=array_append(codes,'UNSCHEDULED_DAY');
    end if;
    if now_at<expected_start_at+(policy.checkin_window_start-policy.expected_start)
      or now_at>expected_start_at+(policy.checkin_window_end-policy.expected_start) then
      codes:=array_append(codes,'OUTSIDE_CHECKIN_WINDOW');
    end if;

    if assignment.id is not null then
      select * into work_session from public.work_sessions linked
      where linked.organization_id=actor.organization_id
        and linked.assignment_id=assignment.id
      for update;
    end if;
    if work_session.id is null then
      perform pg_advisory_xact_lock(hashtextextended(
        'work-session-sequence:'||actor.organization_id::text||':'||actor.internal_id::text||':'||v_business_date::text,0
      ));
      perform wf_private.resequence_work_sessions(
        actor.organization_id,actor.internal_id,v_business_date
      );
      select count(*)+1 into next_sequence
      from public.work_sessions sequence_session
      where sequence_session.organization_id=actor.organization_id
        and sequence_session.employee_internal_id=actor.internal_id
        and sequence_session.business_date=v_business_date;
      if next_sequence>32 then raise exception 'Vượt giới hạn số ca trong ngày.'; end if;
      insert into public.work_sessions(
        organization_id,employee_internal_id,employee_id,assignment_id,business_date,
        session_sequence,policy_id,location_internal_id,location_id,expected_start,
        expected_end,actual_checkin,status,source,exception_codes,late_minutes
      ) values(
        actor.organization_id,actor.internal_id,actor.employee_id,assignment.id,
        v_business_date,next_sequence,policy.id,location.internal_id,site,
        expected_start_at,expected_end_at,now_at,'OPEN','NORMAL',codes,v_late_minutes
      ) returning * into work_session;
    else
      update public.work_sessions
      set policy_id=policy.id,location_internal_id=location.internal_id,
          location_id=site,expected_start=expected_start_at,
          expected_end=expected_end_at,actual_checkin=now_at,
          actual_checkout=null,status='OPEN',source='NORMAL',
          exception_codes=codes,late_minutes=v_late_minutes
      where id=work_session.id and actual_checkin is null and status='SCHEDULED'
      returning * into work_session;
      if not found then
        failure:=wf_private.failure('ALREADY_COMPLETE','Ca này đã được chấm công. Chọn ca kế tiếp hoặc gửi yêu cầu điều chỉnh.');
        return wf_private.finish_attendance_command(actor.organization_id,actor.internal_id,v_command_id,failure,'FAILED');
      end if;
    end if;
    event_kind:='CHECK_IN';
  else
    select * into work_session from public.work_sessions current_session
    where current_session.organization_id=actor.organization_id
      and current_session.employee_internal_id=actor.internal_id
      and current_session.actual_checkin is not null
      and current_session.actual_checkout is null
      and current_session.status='OPEN'
    order by current_session.actual_checkin desc
    limit 1;
    if work_session.id is null then
      failure:=wf_private.failure('NO_ACTIVE_SESSION','Không có ca đang mở.');
      return wf_private.finish_attendance_command(actor.organization_id,actor.internal_id,v_command_id,failure,'FAILED');
    end if;
    active_session_id:=work_session.id;
    v_business_date:=work_session.business_date;
    site:=work_session.location_id;
    perform wf_private.period_lock(actor.organization_id,v_business_date,v_business_date,false);
    if exists(
      select 1 from public.attendance_periods period
      where period.organization_id=actor.organization_id and period.status='CLOSED'
        and v_business_date between period.period_start and period.period_end
    ) or exists(
      select 1 from public.timesheets locked_sheet
      where locked_sheet.organization_id=actor.organization_id
        and locked_sheet.employee_id=actor.employee_id
        and locked_sheet.work_date=v_business_date
        and locked_sheet.status='LOCKED'
    ) then
      failure:=wf_private.failure('PERIOD_LOCKED','Kỳ công đã khóa. Liên hệ HR để xử lý có kiểm soát.');
      return wf_private.finish_attendance_command(actor.organization_id,actor.internal_id,v_command_id,failure,'FAILED');
    end if;

    work_session:=null;
    select * into work_session from public.work_sessions current_session
    where current_session.id=active_session_id
      and current_session.organization_id=actor.organization_id
      and current_session.employee_internal_id=actor.internal_id
      and current_session.actual_checkin is not null
      and current_session.actual_checkout is null
      and current_session.status='OPEN'
    for update;
    if work_session.id is null then
      failure:=wf_private.failure('NO_ACTIVE_SESSION','Ca đang mở đã thay đổi. Vui lòng thử lại.');
      return wf_private.finish_attendance_command(actor.organization_id,actor.internal_id,v_command_id,failure,'FAILED');
    end if;
    v_business_date:=work_session.business_date;
    site:=work_session.location_id;
    select * into policy from public.attendance_policies
    where id=work_session.policy_id and organization_id=actor.organization_id;
    if policy.id is null then
      failure:=wf_private.failure('POLICY_MISSING','Không tìm thấy chính sách lịch sử của ca. Liên hệ quản lý.');
      return wf_private.finish_attendance_command(actor.organization_id,actor.internal_id,v_command_id,failure,'FAILED');
    end if;
    select * into location from public.locations
    where center_id=site and organization_id=actor.organization_id;
    if location.internal_id is null then
      failure:=wf_private.failure('LOCATION_MISSING','Không tìm thấy địa điểm lịch sử của ca. Liên hệ quản lý.');
      return wf_private.finish_attendance_command(actor.organization_id,actor.internal_id,v_command_id,failure,'FAILED');
    end if;
    distance:=tms_private.distance_meters(latitude,longitude,location.latitude,location.longitude);
    if distance>location.radius_meters then
      failure:=wf_private.failure(
        'OUTSIDE_GEOFENCE','Bạn đang ở ngoài phạm vi chấm công.',
        jsonb_build_object('distance',round(distance::numeric),'radius',location.radius_meters)
      );
      return wf_private.finish_attendance_command(actor.organization_id,actor.internal_id,v_command_id,failure,'FAILED');
    end if;

    if action='pause' then
      if work_session.break_started_at is not null then
        failure:=wf_private.failure('ALREADY_PAUSED','Ca đang tạm dừng.');
        return wf_private.finish_attendance_command(actor.organization_id,actor.internal_id,v_command_id,failure,'FAILED');
      end if;
      update public.work_sessions set break_started_at=now_at
      where id=work_session.id returning * into work_session;
      event_kind:='PAUSE';
    elsif action='resume' then
      if work_session.break_started_at is null then
        failure:=wf_private.failure('NOT_PAUSED','Ca hiện không tạm dừng.');
        return wf_private.finish_attendance_command(actor.organization_id,actor.internal_id,v_command_id,failure,'FAILED');
      end if;
      update public.work_sessions
      set break_minutes=break_minutes+greatest(0,floor(extract(epoch from(now_at-break_started_at))/60)::integer),
          break_started_at=null
      where id=work_session.id returning * into work_session;
      event_kind:='RESUME';
    else
      codes:=array_remove(coalesce(work_session.exception_codes,'{}'),'MISSING_CHECKOUT');
      if work_session.expected_end is not null
        and now_at<work_session.expected_end-make_interval(mins=>policy.early_tolerance_minutes) then
        v_early_minutes:=greatest(0,floor(extract(epoch from(work_session.expected_end-now_at))/60)::integer);
        codes:=array_append(codes,'EARLY_LEAVE');
      end if;
      gross_minutes:=greatest(0,floor(extract(epoch from(now_at-work_session.actual_checkin))/60)::integer);
      unpaid_minutes:=work_session.break_minutes+case when work_session.break_started_at is null then 0 else greatest(0,floor(extract(epoch from(now_at-work_session.break_started_at))/60)::integer) end;
      unpaid_minutes:=greatest(unpaid_minutes,case when gross_minutes>=360 then policy.unpaid_break_minutes else 0 end);
      update public.work_sessions
      set actual_checkout=now_at,early_minutes=v_early_minutes,
          work_minutes=greatest(0,gross_minutes-unpaid_minutes),
          break_started_at=null,break_minutes=unpaid_minutes,
          exception_codes=codes,
          status=case when cardinality(codes)>0 then 'NEEDS_REVIEW' when policy.auto_approve then 'AUTO_APPROVED' else 'COMPLETE' end
      where id=work_session.id returning * into work_session;
      event_kind:='CHECK_OUT';
    end if;
  end if;

  -- Compatibility aggregate: one row/day, derived from all sessions. New
  -- product logic consumes work_sessions; this keeps legacy reports correct.
  select
    case
      when bool_or(status in ('NEEDS_REVIEW','PENDING_REVIEW','REJECTED')) then 'EXCEPTION'
      when bool_or(status='OPEN') then 'OPEN'
      when bool_or(status='SCHEDULED') then 'SCHEDULED'
      when bool_and(status='AUTO_APPROVED') then 'AUTO_APPROVED'
      else 'COMPLETE'
    end
  into aggregate_status
  from public.work_sessions aggregate_session
  where aggregate_session.organization_id=actor.organization_id
    and aggregate_session.employee_internal_id=actor.internal_id
    and aggregate_session.business_date=v_business_date
    and aggregate_session.status<>'CANCELLED';

  insert into public.timesheets(
    organization_id,employee_id,work_date,policy_id,location_id,expected_start,expected_end,
    actual_checkin,actual_checkout,status,source,exception_codes,late_minutes,
    early_minutes,work_minutes,break_minutes
  )
  select
    actor.organization_id,actor.employee_id,v_business_date,policy.id,
    (array_agg(session.location_id order by session.session_sequence))[1],
    min(session.expected_start),max(session.expected_end),min(session.actual_checkin),
    case when bool_or(session.status='OPEN') then null else max(session.actual_checkout) end,
    aggregate_status,'NORMAL',
    coalesce(array(
      select distinct code
      from public.work_sessions source_session,
           unnest(source_session.exception_codes) code
      where source_session.organization_id=actor.organization_id
        and source_session.employee_internal_id=actor.internal_id
        and source_session.business_date=v_business_date
      order by code
    ),'{}'),
    sum(session.late_minutes)::integer,sum(session.early_minutes)::integer,
    sum(session.work_minutes)::integer,sum(session.break_minutes)::integer
  from public.work_sessions session
  where session.organization_id=actor.organization_id
    and session.employee_internal_id=actor.internal_id
    and session.business_date=v_business_date
    and session.status<>'CANCELLED'
  on conflict(employee_id,work_date) do update
  set policy_id=excluded.policy_id,location_id=excluded.location_id,
      expected_start=excluded.expected_start,expected_end=excluded.expected_end,
      actual_checkin=excluded.actual_checkin,actual_checkout=excluded.actual_checkout,
      status=excluded.status,source=excluded.source,
      exception_codes=excluded.exception_codes,late_minutes=excluded.late_minutes,
      early_minutes=excluded.early_minutes,work_minutes=excluded.work_minutes,
      break_minutes=excluded.break_minutes
  where public.timesheets.status<>'LOCKED'
  returning * into day_sheet;
  if day_sheet.id is null then
    -- This should be unreachable while holding the shared period lock. Raising
    -- rolls back the session/event changes instead of committing half a punch.
    raise exception 'Bảng công ngày đã khóa trong khi chấm công.' using errcode='55000';
  end if;

  insert into public.attendance_events(
    organization_id,timesheet_id,work_session_id,employee_id,event_type,occurred_at,work_date,
    location_id,qr_station_id,latitude,longitude,gps_accuracy_m,distance_meters,
    gps_state,trusted_device_id,device_verified,outcome,validation
  ) values(
    actor.organization_id,day_sheet.id,work_session.id,actor.employee_id,event_kind,now_at,v_business_date,
    site,qr_session.station_user_id,latitude,longitude,accuracy,distance,'VALID',
    v_device_id,device_ok,'VALID',jsonb_build_object(
      'version',4,'command_id',v_command_id,'policy_id',policy.id,
      'qr_verified',action='checkin','assignment_id',assignment.id
    )
  ) returning id into event_id;

  if event_kind='CHECK_IN' then
    update public.timesheets set checkin_event_id=coalesce(checkin_event_id,event_id)
    where id=day_sheet.id;
  elsif event_kind='CHECK_OUT' then
    update public.timesheets set checkout_event_id=event_id where id=day_sheet.id;
  end if;

  result:=jsonb_build_object(
    'ok',true,
    'receipt',jsonb_build_object(
      'id',receipt_id,'event_id',event_id,'action',action,'occurred_at',now_at,
      'work_date',v_business_date,'location_name',location.center_name,
      'gps_accuracy_m',accuracy,'device_verified',device_ok,
      'timesheet_id',day_sheet.id,'work_session_id',work_session.id,
      'status',work_session.status
    )
  );
  insert into public.workforce_receipts(
    id,organization_id,employee_id,command_id,action,event_id,work_session_id,payload
  ) values(
    receipt_id,actor.organization_id,actor.employee_id,v_command_id,action,event_id,
    work_session.id,result
  );
  insert into public.workforce_metrics(
    organization_id,employee_id,kind,code,duration_ms
  ) values(
    actor.organization_id,actor.employee_id,'ATTENDANCE','SUCCESS',
    least(120000,greatest(0,(extract(epoch from(clock_timestamp()-now_at))*1000)::integer))
  );
  return wf_private.finish_attendance_command(
    actor.organization_id,actor.internal_id,v_command_id,result,'COMPLETED'
  );
end;
$function$;

revoke all on function wf_private.attendance(jsonb)
from public,anon,authenticated,service_role;

-- ---------------------------------------------------------------------------
-- Session-aware, cursor-ready read resources.
-- ---------------------------------------------------------------------------
create table public.organization_config_versions(
  organization_id uuid primary key references public.organizations(id) on delete restrict,
  revision bigint not null default 1 check(revision>0),
  updated_at timestamptz not null default clock_timestamp(),
  updated_by text references public.employees(employee_id) on delete set null
);

create or replace function wf_private.query_v4(
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
  base jsonb;
  rows jsonb:='[]'::jsonb;
  timezone text;
  today date;
  page_size integer:=least(100,greatest(1,coalesce((p->>'size')::integer,30)));
  before_date date:=coalesce(
    (p->'cursor'->>'before_date')::date,
    (p->>'before_date')::date,
    'infinity'::date
  );
  before_sequence integer:=coalesce(
    (p->'cursor'->>'before_sequence')::integer,
    (p->>'before_sequence')::integer,
    32767
  );
  before_id uuid:=coalesce(
    (p->'cursor'->>'before_id')::uuid,
    (p->>'before_id')::uuid,
    'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid
  );
  command_uuid uuid;
begin
  actor:=wf_private.actor();
  timezone:=wf_private.organization_timezone(actor.organization_id);
  today:=wf_private.organization_local_date(actor.organization_id,clock_timestamp());

  if p_resource='today' then
    return jsonb_build_object(
      'server_time',clock_timestamp(),
      'timezone',timezone,
      'local_date',today,
      'sessions',(
        select coalesce(jsonb_agg(to_jsonb(session) order by session.session_sequence),'[]')
        from public.work_sessions session
        where session.organization_id=actor.organization_id
          and session.employee_internal_id=actor.internal_id
          and session.business_date between today-1 and today
          and session.status<>'CANCELLED'
      ),
      'active_session',(
        select to_jsonb(session)
        from public.work_sessions session
        where session.organization_id=actor.organization_id
          and session.employee_internal_id=actor.internal_id
          and session.status='OPEN'
        order by session.actual_checkin desc limit 1
      ),
      'next_assignment',(
        select to_jsonb(assignment)
          || jsonb_build_object('shift_name',shift.name,'location_name',location.center_name)
        from public.shift_assignments assignment
        join public.config_shifts shift
          on shift.organization_id=assignment.organization_id
         and shift.internal_id=assignment.shift_internal_id
        left join public.locations location
          on location.organization_id=assignment.organization_id
         and location.internal_id=assignment.location_internal_id
        where assignment.organization_id=actor.organization_id
          and assignment.employee_internal_id=actor.internal_id
          and assignment.publication_status='PUBLISHED'
          and assignment.scheduled_end>=clock_timestamp()-interval '4 hours'
          and not exists(
            select 1 from public.work_sessions session
            where session.organization_id=actor.organization_id
              and session.assignment_id=assignment.id
              and session.actual_checkin is not null
          )
        order by assignment.scheduled_start limit 1
      )
    );
  elsif p_resource='sessions' then
    select coalesce(jsonb_agg(
      to_jsonb(page)
      order by page.business_date desc,page.session_sequence desc,page.id desc
    ),'[]')
    into rows
    from (
      select session.*
      from public.work_sessions session
      where session.organization_id=actor.organization_id
        and session.employee_id in(select wf_private.scope_ids())
        and (coalesce((p->>'team')::boolean,false) or session.employee_internal_id=actor.internal_id)
        and (session.business_date,session.session_sequence,session.id)
          <(before_date,before_sequence,before_id)
        and session.status<>'CANCELLED'
      order by session.business_date desc,session.session_sequence desc,session.id desc
      limit page_size+1
    ) page;
    return jsonb_build_object(
      'rows',case when jsonb_array_length(rows)>page_size then rows-(-1) else rows end,
      'has_more',jsonb_array_length(rows)>page_size,
      'next_cursor',case when jsonb_array_length(rows)>page_size then
        jsonb_build_object(
          'before_date',(rows->(page_size-1))->>'business_date',
          'before_sequence',((rows->(page_size-1))->>'session_sequence')::integer,
          'before_id',(rows->(page_size-1))->>'id'
        ) else null end,
      'timezone',timezone
    );
  elsif p_resource='attendance_receipt' then
    begin command_uuid:=(p->>'command_id')::uuid;
    exception when others then raise exception 'Mã lệnh không hợp lệ.' using errcode='22023'; end;
    return coalesce((
      select command.response
      from public.attendance_commands command
      where command.organization_id=actor.organization_id
        and command.employee_internal_id=actor.internal_id
        and command.command_id=command_uuid
    ),jsonb_build_object('ok',false,'code','RECEIPT_NOT_FOUND'));
  end if;

  base:=wf_private.query(p_resource,p);
  if p_resource='bootstrap' then
    return base||jsonb_build_object(
      'version',4,
      'server_time',clock_timestamp(),
      'timezone',timezone,
      'local_date',today,
      'sessions_today',(
        select coalesce(jsonb_agg(to_jsonb(session) order by session.session_sequence),'[]')
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
        order by session.actual_checkin desc limit 1
      )
    );
  elsif p_resource='metadata' then
    return base||jsonb_build_object(
      'timezone',timezone,
      'local_date',today,
      'system_settings',(
        select coalesce(jsonb_agg(
          jsonb_build_object('key',setting.key,'value',setting.value)
          order by setting.key
        ),'[]')
        from public.config_system setting
        where setting.organization_id=actor.organization_id
          and setting.key=any(array[
            'MIN_HOURS_FULL','MIN_HOURS_HALF','LUNCH_START','LUNCH_END',
            'APPROVAL_ROLES'
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
        ),'[]')
        from public.locations location
        where location.organization_id=actor.organization_id
      ),
      'qr_timing',jsonb_build_object(
        'refresh_seconds',coalesce((
          select setting.value::integer from public.config_system setting
          where setting.organization_id=actor.organization_id
            and setting.key='QR_REFRESH_SECONDS'
        ),30),
        'validity_seconds',coalesce((
          select setting.value::integer from public.config_system setting
          where setting.organization_id=actor.organization_id
            and setting.key='QR_VALIDITY_SECONDS'
        ),45)
      ),
      'config_revision',coalesce((
        select revision from public.organization_config_versions version
        where version.organization_id=actor.organization_id
      ),1)
    );
  end if;
  return base;
end;
$$;

-- Version table is declared below; create the function body now and validate
-- its deferred relation reference after the table exists in this transaction.
revoke all on function wf_private.query_v4(text,jsonb)
from public,anon,authenticated,service_role;

create or replace function public.workforce_query(
  p_resource text,
  p_args jsonb default '{}'
)
returns jsonb
language sql
security invoker
set search_path=''
as $$ select wf_private.query_v4(p_resource,p_args) $$;
revoke all on function public.workforce_query(text,jsonb) from public,anon;
grant execute on function public.workforce_query(text,jsonb) to authenticated;
grant execute on function wf_private.query_v4(text,jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Optimistic, tenant-wide configuration revisions. A patch is atomic and
-- idempotent; stale clients receive a serialization conflict, never LWW.
-- ---------------------------------------------------------------------------
insert into public.organization_config_versions(organization_id)
select id from public.organizations on conflict do nothing;
alter table public.organization_config_versions enable row level security;
revoke all on table public.organization_config_versions
from public,anon,authenticated,service_role;

create table public.organization_config_commands(
  organization_id uuid not null references public.organizations(id) on delete restrict,
  command_id uuid not null,
  request_hash text not null,
  response jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key(organization_id,command_id)
);
alter table public.organization_config_commands enable row level security;
revoke all on table public.organization_config_commands
from public,anon,authenticated,service_role;

create or replace function wf_private.config_patch(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  actor public.employees%rowtype;
  version public.organization_config_versions%rowtype;
  operation jsonb;
  operations jsonb:=p->'operations';
  command_uuid uuid;
  expected_revision bigint;
  request_hash text;
  existing public.organization_config_commands%rowtype;
  result jsonb;
  resource text;
  verb text;
  record_id bigint;
  record_uuid uuid;
  record_code text;
  setting_key text;
  setting_value text;
  policy_work_days smallint[];
  policy_gps_good integer;
  policy_gps_max integer;
begin
  actor:=wf_private.require_capability('settings.manage');
  begin
    command_uuid:=(p->>'command_id')::uuid;
    expected_revision:=(p->>'expected_revision')::bigint;
  exception when others then
    raise exception 'Mã lệnh hoặc revision cấu hình không hợp lệ.' using errcode='22023';
  end;
  if command_uuid is null or expected_revision is null
    or jsonb_typeof(operations)<>'array'
    or jsonb_array_length(operations) not between 1 and 100 then
    raise exception 'Cần 1–100 thay đổi cấu hình hợp lệ.' using errcode='22023';
  end if;
  request_hash:=encode(extensions.digest(convert_to(p::text,'UTF8'),'sha256'),'hex');
  perform pg_advisory_xact_lock(hashtextextended(
    'config-command:'||actor.organization_id::text||':'||command_uuid::text,0
  ));
  select * into existing from public.organization_config_commands command
  where command.organization_id=actor.organization_id
    and command.command_id=command_uuid;
  if found then
    if existing.request_hash<>request_hash then
      raise exception 'Mã lệnh cấu hình đã được dùng cho nội dung khác.' using errcode='22023';
    end if;
    return existing.response;
  end if;

  insert into public.organization_config_versions(organization_id)
  values(actor.organization_id) on conflict do nothing;
  select * into version from public.organization_config_versions current_version
  where current_version.organization_id=actor.organization_id for update;
  if version.revision<>expected_revision then
    raise exception 'Cấu hình đã thay đổi; tải revision mới trước khi lưu.' using errcode='40001',
      detail=jsonb_build_object('expected',expected_revision,'actual',version.revision)::text;
  end if;
  -- Attendance/payroll hold the shared side of this lock while interpreting
  -- tenant-local dates. Configuration changes must take the exclusive side.
  perform pg_advisory_xact_lock(hashtextextended(
    'workforce-config:'||actor.organization_id::text,0
  ));

  for operation in select value from jsonb_array_elements(operations) loop
    resource:=operation->>'resource';
    verb:=coalesce(operation->>'op','upsert');
    if resource='system' and verb='upsert' then
      setting_key:=operation->>'key';
      setting_value:=operation->>'value';
      if setting_key is null
        or setting_key not in(
          'LATE_TOLERANCE','MIN_HOURS_FULL','MIN_HOURS_HALF',
          'LUNCH_START','LUNCH_END','OFF_DAYS','MAX_DISTANCE_METERS',
          'LOCK_DATE','MAX_EXPLANATIONS_PER_MONTH',
          'QR_REFRESH_SECONDS','QR_VALIDITY_SECONDS','APPROVAL_ROLES'
        )
        or setting_value is null or char_length(setting_value)>4000 then
        raise exception 'Khóa cấu hình hệ thống không hợp lệ.' using errcode='22023';
      end if;

      if setting_key in(
        'LATE_TOLERANCE','MAX_DISTANCE_METERS','LOCK_DATE',
        'MAX_EXPLANATIONS_PER_MONTH','QR_REFRESH_SECONDS','QR_VALIDITY_SECONDS'
      ) then
        if setting_value !~ '^[0-9]+$' then
          raise exception 'Giá trị % phải là số nguyên hợp lệ.',setting_key using errcode='22023';
        end if;
        if (setting_key='LATE_TOLERANCE' and setting_value::integer not between 0 and 180)
          or (setting_key='MAX_DISTANCE_METERS' and setting_value::integer not between 20 and 1000)
          or (setting_key='LOCK_DATE' and setting_value::integer not between 1 and 31)
          or (setting_key='MAX_EXPLANATIONS_PER_MONTH' and setting_value::integer not between 1 and 50)
          or (setting_key='QR_REFRESH_SECONDS' and setting_value::integer not between 10 and 240)
          or (setting_key='QR_VALIDITY_SECONDS' and setting_value::integer not between 15 and 300) then
          raise exception 'Giá trị % nằm ngoài phạm vi cho phép.',setting_key using errcode='22023';
        end if;
      elsif setting_key in('MIN_HOURS_FULL','MIN_HOURS_HALF') then
        if setting_value !~ '^[0-9]+([.][0-9]+)?$' then
          raise exception 'Giá trị % không phải số giờ hợp lệ.',setting_key using errcode='22023';
        end if;
        if (setting_key='MIN_HOURS_FULL' and setting_value::numeric not between 1 and 24)
          or (setting_key='MIN_HOURS_HALF' and setting_value::numeric not between 0.5 and 12) then
          raise exception 'Giá trị % không phải số giờ hợp lệ.',setting_key using errcode='22023';
        end if;
      elsif setting_key in('LUNCH_START','LUNCH_END') then
        if setting_value !~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$' then
          raise exception 'Giá trị % không phải giờ hợp lệ.',setting_key using errcode='22023';
        end if;
      elsif setting_key='OFF_DAYS' then
        if setting_value !~ '^$|^[0-6](,[0-6])*$'
          or (
            select count(*)<>count(distinct day)
            from unnest(string_to_array(setting_value,',')) day
          ) then
          raise exception 'OFF_DAYS phải là danh sách ngày 0–6 không trùng lặp.' using errcode='22023';
        end if;
      end if;
      insert into public.config_system(organization_id,key,value,updated_at)
      values(actor.organization_id,setting_key,setting_value,clock_timestamp())
      on conflict(organization_id,key) do update
      set value=excluded.value,updated_at=excluded.updated_at;
    elsif resource='shift' and verb='upsert' then
      record_id:=nullif(operation->>'id','')::bigint;
      if record_id is null then
        insert into public.config_shifts(
          organization_id,name,start_time,end_time,break_point,sort_order,active
        ) values(
          actor.organization_id,left(trim(operation->>'name'),120),
          (operation->>'start_time')::time,(operation->>'end_time')::time,
          coalesce((operation->>'break_point')::time,'00:00'::time),
          coalesce((operation->>'sort_order')::integer,0),
          coalesce((operation->>'active')::boolean,true)
        ) on conflict(organization_id,name) do update
        set start_time=excluded.start_time,end_time=excluded.end_time,
            break_point=excluded.break_point,sort_order=excluded.sort_order,
            active=excluded.active;
      else
        update public.config_shifts
        set name=left(trim(operation->>'name'),120),
            start_time=(operation->>'start_time')::time,
            end_time=(operation->>'end_time')::time,
            break_point=coalesce((operation->>'break_point')::time,break_point),
            sort_order=coalesce((operation->>'sort_order')::integer,sort_order),
            active=coalesce((operation->>'active')::boolean,active)
        where organization_id=actor.organization_id and id=record_id;
        if not found then raise exception 'Không tìm thấy ca cần cập nhật.'; end if;
      end if;
    elsif resource='holiday' and verb in ('upsert','deactivate') then
      record_id:=nullif(operation->>'id','')::bigint;
      if verb='deactivate' then
        update public.holidays set active=false
        where organization_id=actor.organization_id and id=record_id;
      elsif record_id is null then
        insert into public.holidays(
          organization_id,name,from_date,to_date,paid,active
        ) values(
          actor.organization_id,left(trim(operation->>'name'),160),
          (operation->>'from_date')::date,(operation->>'to_date')::date,
          coalesce((operation->>'paid')::boolean,true),
          coalesce((operation->>'active')::boolean,true)
        );
      else
        update public.holidays
        set name=left(trim(operation->>'name'),160),
            from_date=(operation->>'from_date')::date,
            to_date=(operation->>'to_date')::date,
            paid=coalesce((operation->>'paid')::boolean,paid),
            active=coalesce((operation->>'active')::boolean,active)
        where organization_id=actor.organization_id and id=record_id;
        if not found then raise exception 'Không tìm thấy ngày lễ cần cập nhật.'; end if;
      end if;
    elsif resource='policy' and verb='upsert' then
      record_uuid:=nullif(operation->>'id','')::uuid;
      begin
        select coalesce(
          array_agg(day.value::smallint order by day.ordinality),
          '{}'::smallint[]
        ) into policy_work_days
        from jsonb_array_elements_text(operation->'work_days')
          with ordinality as day(value,ordinality);
        policy_gps_good:=coalesce((operation->>'gps_good_accuracy_m')::integer,50);
        policy_gps_max:=coalesce((operation->>'gps_max_accuracy_m')::integer,150);
      exception when others then
        raise exception 'Ngày làm việc hoặc ngưỡng GPS không hợp lệ.' using errcode='22023';
      end;
      if cardinality(policy_work_days)=0
        or exists(select 1 from unnest(policy_work_days) day where day not between 1 and 7)
        or cardinality(policy_work_days)<>(select count(distinct day) from unnest(policy_work_days) day) then
        raise exception 'Chính sách cần các ngày làm việc 1–7, không trùng lặp.' using errcode='22023';
      end if;
      if policy_gps_good>policy_gps_max then
        raise exception 'Ngưỡng GPS tốt không được lớn hơn ngưỡng GPS chấp nhận.' using errcode='22023';
      end if;
      if record_uuid is null then
        insert into public.attendance_policies(
          organization_id,name,work_days,expected_start,expected_end,
          late_tolerance_minutes,early_tolerance_minutes,
          checkin_window_start,checkin_window_end,
          checkout_window_start,checkout_window_end,
          checkout_grace_minutes,
          gps_good_accuracy_m,gps_max_accuracy_m,unpaid_break_minutes,
          auto_approve,active,updated_at
        ) values(
          actor.organization_id,left(trim(operation->>'name'),160),
          policy_work_days,
          (operation->>'expected_start')::time,(operation->>'expected_end')::time,
          coalesce((operation->>'late_tolerance_minutes')::integer,5),
          coalesce((operation->>'early_tolerance_minutes')::integer,5),
          (operation->>'checkin_window_start')::time,(operation->>'checkin_window_end')::time,
          (operation->>'checkout_window_start')::time,(operation->>'checkout_window_end')::time,
          coalesce((operation->>'checkout_grace_minutes')::integer,240),
          policy_gps_good,
          policy_gps_max,
          coalesce((operation->>'unpaid_break_minutes')::integer,90),
          coalesce((operation->>'auto_approve')::boolean,true),
          coalesce((operation->>'active')::boolean,true),clock_timestamp()
        );
      else
        update public.attendance_policies
        set name=left(trim(operation->>'name'),160),
            work_days=policy_work_days,
            expected_start=(operation->>'expected_start')::time,
            expected_end=(operation->>'expected_end')::time,
            late_tolerance_minutes=(operation->>'late_tolerance_minutes')::integer,
            early_tolerance_minutes=(operation->>'early_tolerance_minutes')::integer,
            checkin_window_start=(operation->>'checkin_window_start')::time,
            checkin_window_end=(operation->>'checkin_window_end')::time,
            checkout_window_start=(operation->>'checkout_window_start')::time,
            checkout_window_end=(operation->>'checkout_window_end')::time,
            checkout_grace_minutes=coalesce(
              (operation->>'checkout_grace_minutes')::integer,checkout_grace_minutes
            ),
            gps_good_accuracy_m=policy_gps_good,
            gps_max_accuracy_m=policy_gps_max,
            unpaid_break_minutes=(operation->>'unpaid_break_minutes')::integer,
            auto_approve=coalesce((operation->>'auto_approve')::boolean,auto_approve),
            active=coalesce((operation->>'active')::boolean,active),
            updated_at=clock_timestamp()
        where organization_id=actor.organization_id and id=record_uuid;
        if not found then raise exception 'Không tìm thấy chính sách cần cập nhật.'; end if;
      end if;
    elsif resource='location' and verb='upsert' then
      record_code:=upper(trim(operation->>'center_id'));
      if record_code !~ '^[A-Z0-9][A-Z0-9_-]{1,79}$' then
        raise exception 'Mã địa điểm không hợp lệ.' using errcode='22023';
      end if;
      if exists(
        select 1 from public.locations location
        where location.center_id=record_code
          and location.organization_id<>actor.organization_id
      ) then raise exception 'Mã địa điểm đã thuộc tổ chức khác.' using errcode='23505'; end if;
      insert into public.locations(
        organization_id,center_id,center_name,address,city,latitude,longitude,
        radius_meters,active,updated_at
      ) values(
        actor.organization_id,record_code,left(trim(operation->>'center_name'),160),
        nullif(trim(operation->>'address'),''),nullif(trim(operation->>'city'),''),
        (operation->>'latitude')::double precision,(operation->>'longitude')::double precision,
        (operation->>'radius_meters')::integer,
        coalesce((operation->>'active')::boolean,true),clock_timestamp()
      ) on conflict(center_id) do update
      set center_name=excluded.center_name,address=excluded.address,city=excluded.city,
          latitude=excluded.latitude,longitude=excluded.longitude,
          radius_meters=excluded.radius_meters,active=excluded.active,
          updated_at=excluded.updated_at
      where public.locations.organization_id=actor.organization_id;
    elsif resource='station' and verb='upsert' then
      record_uuid:=nullif(operation->>'id','')::uuid;
      if record_uuid is null then
        raise exception 'Chỉ được cập nhật trạm đã cấp danh tính Auth.' using errcode='22023';
      end if;
      update public.qr_stations
      set name=left(trim(operation->>'name'),160),
          center_id=operation->>'center_id',
          active=coalesce((operation->>'active')::boolean,active),
          updated_at=clock_timestamp()
      where organization_id=actor.organization_id and id=record_uuid
        and exists(
          select 1 from public.locations location
          where location.organization_id=actor.organization_id
            and location.center_id=operation->>'center_id'
        );
      if not found then raise exception 'Không tìm thấy trạm hoặc địa điểm hợp lệ.'; end if;
    elsif resource='organization' and verb='timezone' then
      if not exists(
        select 1 from pg_catalog.pg_timezone_names zone
        where zone.name=operation->>'timezone'
      ) then raise exception 'Múi giờ IANA không hợp lệ.' using errcode='22023'; end if;
      if exists(
        select 1 from public.organizations organization
        where organization.id=actor.organization_id
          and organization.timezone is distinct from operation->>'timezone'
      ) and (
        exists(select 1 from public.work_sessions session
          where session.organization_id=actor.organization_id)
        or exists(select 1 from public.shift_assignments assignment
          where assignment.organization_id=actor.organization_id)
        or exists(select 1 from public.timesheets sheet
          where sheet.organization_id=actor.organization_id)
      ) then
        raise exception 'Không thể đổi múi giờ sau khi đã có dữ liệu chấm công hoặc lịch ca.'
          using errcode='55000';
      end if;
      update public.organizations
      set timezone=operation->>'timezone'
      where id=actor.organization_id;
    else
      raise exception 'Thao tác cấu hình không được hỗ trợ: %.%',resource,verb using errcode='22023';
    end if;
  end loop;

  if coalesce((
      select value::numeric from public.config_system
      where organization_id=actor.organization_id and key='MIN_HOURS_HALF'
    ),3.5) > coalesce((
      select value::numeric from public.config_system
      where organization_id=actor.organization_id and key='MIN_HOURS_FULL'
    ),7) then
    raise exception 'Số giờ nửa ngày không được lớn hơn số giờ đủ ngày.' using errcode='22023';
  end if;
  if coalesce((
      select value::time from public.config_system
      where organization_id=actor.organization_id and key='LUNCH_START'
    ),'12:00'::time) >= coalesce((
      select value::time from public.config_system
      where organization_id=actor.organization_id and key='LUNCH_END'
    ),'13:30'::time) then
    raise exception 'Giờ kết thúc nghỉ trưa phải sau giờ bắt đầu.' using errcode='22023';
  end if;
  if coalesce((
      select value::integer from public.config_system
      where organization_id=actor.organization_id and key='QR_REFRESH_SECONDS'
    ),30) >= coalesce((
      select value::integer from public.config_system
      where organization_id=actor.organization_id and key='QR_VALIDITY_SECONDS'
    ),45) then
    raise exception 'Thời gian hiệu lực QR phải lớn hơn chu kỳ làm mới.' using errcode='22023';
  end if;

  update public.organization_config_versions
  set revision=revision+1,updated_at=clock_timestamp(),updated_by=actor.employee_id
  where organization_id=actor.organization_id returning * into version;
  perform wf_private.audit(
    'CONFIG_PATCHED','organization',actor.organization_id::text,
    'Cập nhật cấu hình theo revision',
    jsonb_build_object('revision',version.revision,'command_id',command_uuid,'operations',operations)
  );
  result:=jsonb_build_object('ok',true,'revision',version.revision);
  insert into public.organization_config_commands(
    organization_id,command_id,request_hash,response
  ) values(actor.organization_id,command_uuid,request_hash,result);
  return result;
end;
$$;
revoke all on function wf_private.config_patch(jsonb)
from public,anon,authenticated,service_role;

create or replace function wf_private.command_v4(p_action text,p jsonb)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
begin
  if p_action='config.patch' then return wf_private.config_patch(p); end if;
  return wf_private.command(p_action,p);
end;
$$;
revoke all on function wf_private.command_v4(text,jsonb)
from public,anon,authenticated,service_role;

create or replace function public.workforce_command(
  p_action text,
  p_args jsonb default '{}'
)
returns jsonb
language sql
security invoker
set search_path=''
as $$ select wf_private.command_v4(p_action,p_args) $$;
revoke all on function public.workforce_command(text,jsonb) from public,anon;
grant execute on function public.workforce_command(text,jsonb) to authenticated;
grant execute on function wf_private.command_v4(text,jsonb),wf_private.config_patch(jsonb)
to authenticated;

-- ---------------------------------------------------------------------------
-- Session-aware schedule writes. Existing clients keep replace-day semantics;
-- new clients may send mode=append or assignment_id for multiple shifts/day.
-- ---------------------------------------------------------------------------
create or replace function wf_private.schedule_save(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  actor public.employees%rowtype;
  employee public.employees%rowtype;
  shift public.config_shifts%rowtype;
  existing public.shift_assignments%rowtype;
  saved public.shift_assignments%rowtype;
  item jsonb;
  target_work_date date;
  site text;
  count_saved integer:=0;
  why text:=trim(coalesce(p->>'override_reason',''));
  publish_state text;
  assignment_uuid uuid;
  mode text;
  today date;
  matching_assignments integer;
  lock_first_date date;
  lock_last_date date;
  source_work_date date;
begin
  actor:=wf_private.require_capability('schedule.manage');
  -- Freeze timezone/config before deriving tenant-local dates. This uses the
  -- same protocol as attendance and payroll close.
  perform pg_advisory_xact_lock_shared(hashtextextended(
    'workforce-config:'||actor.organization_id::text,0
  ));
  today:=wf_private.organization_local_date(actor.organization_id,clock_timestamp());
  if jsonb_typeof(p->'assignments')<>'array'
    or jsonb_array_length(p->'assignments') not between 1 and 500 then
    raise exception 'Cần từ 1 đến 500 lịch phân ca.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('schedule:'||actor.organization_id::text,0));

  -- Join the payroll-period protocol before taking assignment row locks. A
  -- batch may arrive in any order, so acquire one chronological month range
  -- covering every target date and every existing assignment being moved.
  for item in select value from jsonb_array_elements(p->'assignments') loop
    begin
      target_work_date:=(item->>'work_date')::date;
      assignment_uuid:=nullif(item->>'assignment_id','')::uuid;
    exception when others then
      raise exception 'Ngày hoặc mã lịch phân ca không hợp lệ.' using errcode='22023';
    end;
    if target_work_date is null or target_work_date<today or target_work_date>today+366 then
      raise exception 'Ngày phân ca phải từ hôm nay đến một năm tới.';
    end if;
    lock_first_date:=least(coalesce(lock_first_date,target_work_date),target_work_date);
    lock_last_date:=greatest(coalesce(lock_last_date,target_work_date),target_work_date);
    if assignment_uuid is not null then
      source_work_date:=null;
      select assignment.work_date into source_work_date
      from public.shift_assignments assignment
      where assignment.organization_id=actor.organization_id
        and assignment.id=assignment_uuid;
      if source_work_date is not null then
        lock_first_date:=least(lock_first_date,source_work_date);
        lock_last_date:=greatest(lock_last_date,source_work_date);
      end if;
    end if;
  end loop;
  perform wf_private.period_lock(
    actor.organization_id,lock_first_date,lock_last_date,false
  );

  for item in select value from jsonb_array_elements(p->'assignments') loop
    existing:=null;
    saved:=null;
    target_work_date:=(item->>'work_date')::date;
    mode:=coalesce(item->>'mode','replace_day');
    assignment_uuid:=nullif(item->>'assignment_id','')::uuid;
    if mode not in ('replace_day','append') then
      raise exception 'Chế độ lưu lịch không hợp lệ.' using errcode='22023';
    end if;
    if target_work_date is null or target_work_date<today or target_work_date>today+366 then
      raise exception 'Ngày phân ca phải từ hôm nay đến một năm tới.';
    end if;
    if not wf_private.in_scope(item->>'employee_id') then
      raise exception 'Nhân viên ngoài phạm vi quản lý.' using errcode='42501';
    end if;
    select * into employee from public.employees
    where employee_id=item->>'employee_id'
      and organization_id=actor.organization_id
      and status='Active' and role<>'Kiosk';
    if not found then raise exception 'Nhân viên không hoạt động.'; end if;
    select * into shift from public.config_shifts
    where id=(item->>'shift_id')::bigint
      and organization_id=actor.organization_id and active;
    if not found then raise exception 'Ca làm không hợp lệ.'; end if;
    site:=coalesce(nullif(item->>'location_id',''),employee.center_id);
    if not exists(
      select 1 from public.locations location
      where location.center_id=site
        and location.organization_id=actor.organization_id and location.active
    ) then raise exception 'Địa điểm không hợp lệ.'; end if;
    if site<>employee.center_id and not(site=any(coalesce(employee.allowed_locations,'{}'))) then
      raise exception 'Nhân viên chưa được cấp quyền cho địa điểm này.';
    end if;
    if exists(
      select 1 from public.attendance_periods period
      where period.organization_id=actor.organization_id and period.status='CLOSED'
        and target_work_date between period.period_start and period.period_end
    ) then raise exception 'Kỳ công đã khóa.'; end if;

    if assignment_uuid is not null then
      select * into existing from public.shift_assignments assignment
      where assignment.id=assignment_uuid
        and assignment.organization_id=actor.organization_id
        and assignment.employee_internal_id=employee.internal_id
      for update;
      if existing.id is null then
        raise exception 'Không tìm thấy lịch cần cập nhật.' using errcode='P0002';
      end if;
      if exists(
        select 1 from public.attendance_periods period
        where period.organization_id=actor.organization_id
          and period.status='CLOSED'
          and existing.work_date between period.period_start and period.period_end
      ) then raise exception 'Kỳ công nguồn đã khóa.'; end if;
    elsif mode='replace_day' then
      select count(*) into matching_assignments
      from public.shift_assignments assignment
      where assignment.organization_id=actor.organization_id
        and assignment.employee_internal_id=employee.internal_id
        and assignment.work_date=target_work_date;
      if matching_assignments>1 then
        raise exception 'Ngày này có nhiều ca; cần chọn đúng assignment_id để cập nhật.' using errcode='22023';
      end if;
      select * into existing from public.shift_assignments assignment
      where assignment.organization_id=actor.organization_id
        and assignment.employee_internal_id=employee.internal_id
        and assignment.work_date=target_work_date
      order by assignment.scheduled_start,assignment.id
      limit 1 for update;
    else
      existing:=null;
    end if;

    if existing.id is not null then
      if coalesce((item->>'revision')::bigint,0)<>existing.revision then
        raise exception 'Lịch đã thay đổi. Tải lại trước khi sửa.' using errcode='40001';
      end if;
      if exists(
        select 1 from public.work_sessions session
        where session.assignment_id=existing.id and session.actual_checkin is not null
      ) then raise exception 'Ca đã có chấm công; không được thay lịch.'; end if;
      if existing.publication_status='PUBLISHED'
        and (length(why)<5 or not wf_private.capable('schedule.override')) then
        raise exception 'Lịch đã công bố. Cần quyền sửa lịch và lý do.';
      end if;
      publish_state:=case
        when item ? 'publish' then
          case when coalesce((item->>'publish')::boolean,false) then 'PUBLISHED' else 'DRAFT' end
        else existing.publication_status
      end;
      if publish_state='PUBLISHED'
        and existing.publication_status<>'PUBLISHED'
        and not wf_private.capable('schedule.override') then
        raise exception 'Cần quyền công bố lịch.' using errcode='42501';
      end if;
      update public.shift_assignments
      set work_date=target_work_date,shift_id=shift.id,location_id=site,
          note=left(coalesce(item->>'note',''),500),created_by=actor.employee_id,
          publication_status=publish_state,
          published_at=case
            when publish_state='PUBLISHED' then coalesce(published_at,clock_timestamp())
            else null
          end,
          published_by=case
            when publish_state='PUBLISHED' then coalesce(published_by,actor.employee_id)
            else null
          end
      where id=existing.id returning * into saved;
    else
      publish_state:=case when coalesce((item->>'publish')::boolean,false) then 'PUBLISHED' else 'DRAFT' end;
      if publish_state='PUBLISHED' and not wf_private.capable('schedule.override') then
        raise exception 'Cần quyền công bố lịch.' using errcode='42501';
      end if;
      insert into public.shift_assignments(
        organization_id,employee_id,work_date,shift_id,location_id,note,
        created_by,publication_status,published_at,published_by
      ) values(
        actor.organization_id,employee.employee_id,target_work_date,shift.id,site,
        left(coalesce(item->>'note',''),500),actor.employee_id,publish_state,
        case when publish_state='PUBLISHED' then clock_timestamp() end,
        case when publish_state='PUBLISHED' then actor.employee_id end
      ) returning * into saved;
    end if;
    if publish_state='PUBLISHED' then
      perform wf_private.notify(
        employee.employee_id,
        'schedule-change:'||saved.id::text||':'||saved.revision::text,
        'SCHEDULE_CHANGED','Lịch làm việc đã thay đổi',
        target_work_date::text||' · '||shift.name,
        jsonb_build_object('date',target_work_date,'assignment_id',saved.id)
      );
    end if;
    count_saved:=count_saved+1;
  end loop;
  perform wf_private.audit(
    'SCHEDULE_SAVED','shift_assignment',null,
    coalesce(nullif(why,''),'Lập lịch'),
    jsonb_build_object('count',count_saved)
  );
  return jsonb_build_object('ok',true,'count',count_saved);
end;
$function$;
revoke all on function wf_private.schedule_save(jsonb)
from public,anon,authenticated,service_role;

-- ---------------------------------------------------------------------------
-- Database-enforced last-admin invariant.
-- ---------------------------------------------------------------------------
create or replace function wf_private.protect_last_active_admin()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
declare remaining integer;
begin
  if old.role='Admin' and old.status='Active'
    and (
      tg_op='DELETE'
      or new.role<>'Admin'
      or new.status<>'Active'
      or new.organization_id<>old.organization_id
    ) then
    perform pg_advisory_xact_lock(hashtextextended(
      'last-active-admin:'||old.organization_id::text,0
    ));
    select count(*) into remaining
    from public.employees employee
    where employee.organization_id=old.organization_id
      and employee.role='Admin' and employee.status='Active'
      and employee.internal_id<>old.internal_id;
    if remaining<1 then
      raise exception 'Tổ chức phải luôn có ít nhất một Admin hoạt động.' using errcode='23514';
    end if;
  end if;
  return case when tg_op='DELETE' then old else new end;
end;
$$;
revoke all on function wf_private.protect_last_active_admin()
from public,anon,authenticated,service_role;
drop trigger if exists employees_protect_last_active_admin on public.employees;
create trigger employees_protect_last_active_admin
before update of role,status,organization_id or delete on public.employees
for each row execute function wf_private.protect_last_active_admin();

-- ---------------------------------------------------------------------------
-- Atomic trusted-device primitives for Edge Functions. Crypto verification
-- remains at the edge, while every state transition for one employee shares a
-- single transaction-scoped lock. This prevents activation/challenge/consume
-- from racing an administrative reset.
-- ---------------------------------------------------------------------------
create or replace function public.activate_trusted_device_v1(
  p_employee_id text,
  p_device_id text,
  p_public_key_jwk jsonb,
  p_device_label text default null,
  p_user_agent text default null
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  target_organization_id uuid;
  target_employee public.employees%rowtype;
  active_device public.trusted_devices%rowtype;
  requested_device public.trusted_devices%rowtype;
  now_at timestamptz:=clock_timestamp();
  activated boolean:=false;
begin
  if length(coalesce(p_device_id,'')) not between 12 and 180
    or jsonb_typeof(p_public_key_jwk) is distinct from 'object'
    or p_public_key_jwk->>'kty' is distinct from 'EC'
    or p_public_key_jwk->>'crv' is distinct from 'P-256'
    or length(coalesce(p_public_key_jwk->>'x','')) not between 40 and 100
    or length(coalesce(p_public_key_jwk->>'y','')) not between 40 and 100
    or p_public_key_jwk ? 'd' then
    raise exception 'Thông tin khóa thiết bị không hợp lệ.' using errcode='22023';
  end if;

  select employee.organization_id into target_organization_id
  from public.employees employee
  where employee.employee_id=p_employee_id;
  if target_organization_id is null then
    return jsonb_build_object('ok',false,'code','EMPLOYEE_NOT_FOUND');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'trusted-device-employee:'||target_organization_id::text||':'||p_employee_id,0
  ));
  perform pg_advisory_xact_lock(hashtextextended(
    'trusted-device-id:'||p_device_id,0
  ));
  select * into target_employee
  from public.employees employee
  where employee.employee_id=p_employee_id
    and employee.organization_id=target_organization_id
    and employee.status='Active'
  for update;
  if target_employee.internal_id is null then
    return jsonb_build_object('ok',false,'code','EMPLOYEE_INACTIVE_OR_MOVED');
  end if;

  select * into active_device
  from public.trusted_devices device
  where device.organization_id=target_organization_id
    and device.employee_id=p_employee_id
    and device.status='ACTIVE'
  order by device.activated_at desc,device.device_id
  limit 1
  for update;
  if active_device.device_id is not null
    and active_device.device_id<>p_device_id then
    return jsonb_build_object('ok',false,'code','DEVICE_ALREADY_BOUND');
  end if;

  select * into requested_device
  from public.trusted_devices device
  where device.device_id=p_device_id
  for update;
  if requested_device.device_id is not null and (
    requested_device.organization_id is distinct from target_organization_id
    or requested_device.employee_id is distinct from p_employee_id
  ) then
    return jsonb_build_object('ok',false,'code','DEVICE_ID_CONFLICT');
  end if;
  if active_device.device_id is not null
    and active_device.public_key_jwk is distinct from p_public_key_jwk then
    return jsonb_build_object('ok',false,'code','DEVICE_KEY_MISMATCH');
  end if;

  if requested_device.device_id is null then
    insert into public.trusted_devices(
      device_id,employee_id,organization_id,public_key_jwk,device_label,
      user_agent,status,activated_at,last_seen_at
    ) values(
      p_device_id,p_employee_id,target_organization_id,p_public_key_jwk,
      left(nullif(trim(p_device_label),''),160),
      left(nullif(trim(p_user_agent),''),500),'ACTIVE',now_at,now_at
    );
    activated:=true;
  elsif requested_device.status='REVOKED' then
    update public.trusted_devices
    set public_key_jwk=p_public_key_jwk,
        device_label=left(nullif(trim(p_device_label),''),160),
        user_agent=left(nullif(trim(p_user_agent),''),500),
        status='ACTIVE',activated_at=now_at,last_seen_at=now_at,
        revoked_at=null,revoked_by=null,revoke_reason=null
    where device_id=p_device_id;
    activated:=true;
  end if;

  update public.employees
  set trusted_device_id=p_device_id,
      trusted_device_bound_at=coalesce(trusted_device_bound_at,now_at),
      updated_at=now_at
  where organization_id=target_organization_id
    and employee_id=p_employee_id
    and (
      trusted_device_id is distinct from p_device_id
      or trusted_device_bound_at is null
    );

  if activated then
    insert into public.audit_logs(
      organization_id,actor_employee_id,target_employee_id,action,
      entity_type,entity_id,reason,metadata
    ) values(
      target_organization_id,p_employee_id,p_employee_id,
      'TRUSTED_DEVICE_ACTIVATED','trusted_device',p_device_id,
      'Kích hoạt thiết bị tin cậy',jsonb_build_object(
        'organization_id',target_organization_id,
        'device_label',left(nullif(trim(p_device_label),''),160),
        'user_agent',left(nullif(trim(p_user_agent),''),500)
      )
    );
  end if;
  return jsonb_build_object(
    'ok',true,'state','ACTIVE','device_id',p_device_id,
    'activated_at',case
      when activated then now_at
      else requested_device.activated_at
    end
  );
end;
$$;

create or replace function public.create_trusted_device_challenge_v1(
  p_employee_id text,
  p_device_id text,
  p_ttl_seconds integer default 120
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  target_organization_id uuid;
  active_device public.trusted_devices%rowtype;
  challenge_id uuid;
  raw_challenge text;
  expires_at timestamptz;
begin
  if p_ttl_seconds not between 30 and 300 then
    raise exception 'Thời hạn challenge không hợp lệ.' using errcode='22023';
  end if;
  select employee.organization_id into target_organization_id
  from public.employees employee
  where employee.employee_id=p_employee_id and employee.status='Active';
  if target_organization_id is null then
    return jsonb_build_object('ok',false,'code','EMPLOYEE_NOT_FOUND');
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'trusted-device-employee:'||target_organization_id::text||':'||p_employee_id,0
  ));
  select device.* into active_device
  from public.trusted_devices device
  join public.employees employee
    on employee.organization_id=device.organization_id
   and employee.employee_id=device.employee_id
   and employee.status='Active'
  where device.organization_id=target_organization_id
    and device.employee_id=p_employee_id
    and device.device_id=p_device_id
    and device.status='ACTIVE'
  for update of device;
  if active_device.device_id is null then
    return jsonb_build_object('ok',false,'code','DEVICE_REVOKED_OR_MISMATCH');
  end if;

  raw_challenge:=regexp_replace(
    translate(encode(extensions.gen_random_bytes(32),'base64'),'+/','-_'),
    E'[=\\n\\r]+','','g'
  );
  expires_at:=clock_timestamp()+make_interval(secs=>p_ttl_seconds);
  insert into public.trusted_device_challenges(
    employee_id,device_id,challenge,expires_at
  ) values(
    p_employee_id,p_device_id,raw_challenge,expires_at
  ) returning id into challenge_id;
  return jsonb_build_object(
    'ok',true,'challenge_id',challenge_id,
    'challenge',raw_challenge,'expires_at',expires_at
  );
end;
$$;

create or replace function public.consume_trusted_device_challenge_v1(
  p_challenge_id uuid,
  p_employee_id text,
  p_device_id text,
  p_grant_seconds integer default 2592000
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  challenge public.trusted_device_challenges%rowtype;
  target_organization_id uuid;
  grant_expires_at timestamptz;
begin
  if p_grant_seconds not between 300 and 31536000 then
    raise exception 'Thời hạn thiết bị không hợp lệ.' using errcode='22023';
  end if;
  select employee.organization_id into target_organization_id
  from public.employees employee
  where employee.employee_id=p_employee_id and employee.status='Active';
  if target_organization_id is null then return jsonb_build_object('ok',false,'code','EMPLOYEE_NOT_FOUND'); end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'trusted-device-employee:'||target_organization_id::text||':'||p_employee_id,0
  ));
  update public.trusted_device_challenges candidate
  set used_at=clock_timestamp()
  where candidate.id=p_challenge_id
    and candidate.employee_id=p_employee_id
    and candidate.device_id=p_device_id
    and candidate.used_at is null
    and candidate.expires_at>clock_timestamp()
    and exists(
      select 1 from public.trusted_devices device
      where device.organization_id=target_organization_id
        and device.employee_id=p_employee_id
        and device.device_id=p_device_id
        and device.status='ACTIVE'
    )
  returning candidate.* into challenge;
  if challenge.id is null then
    return jsonb_build_object('ok',false,'code','CHALLENGE_CONSUMED_EXPIRED_OR_REVOKED');
  end if;
  grant_expires_at:=clock_timestamp()+make_interval(secs=>p_grant_seconds);
  insert into public.trusted_device_grants(
    employee_id,device_id,verified_at,expires_at,updated_at
  ) values(
    p_employee_id,p_device_id,clock_timestamp(),
    grant_expires_at,clock_timestamp()
  )
  on conflict(employee_id) do update
  set device_id=excluded.device_id,verified_at=excluded.verified_at,
      expires_at=excluded.expires_at,updated_at=excluded.updated_at;
  update public.trusted_devices
  set last_seen_at=challenge.used_at
  where organization_id=target_organization_id
    and employee_id=p_employee_id and device_id=p_device_id
    and status='ACTIVE';
  return jsonb_build_object(
    'ok',true,'verified_at',challenge.used_at,'expires_at',grant_expires_at
  );
end;
$$;

create or replace function public.reset_trusted_device_v1(
  p_employee_id text,
  p_actor_employee_id text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  target_organization_id uuid;
  target_employee public.employees%rowtype;
  count_reset integer:=0;
  old_devices jsonb:='[]'::jsonb;
begin
  select employee.organization_id into target_organization_id
  from public.employees employee where employee.employee_id=p_employee_id;
  if target_organization_id is null then return jsonb_build_object('ok',false,'code','EMPLOYEE_NOT_FOUND'); end if;
  if length(trim(coalesce(p_reason,'')))<3 then
    raise exception 'Lý do đặt lại thiết bị quá ngắn.' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'trusted-device-employee:'||target_organization_id::text||':'||p_employee_id,0
  ));
  select * into target_employee
  from public.employees employee
  where employee.organization_id=target_organization_id
    and employee.employee_id=p_employee_id
  for update;
  if target_employee.internal_id is null then
    return jsonb_build_object('ok',false,'code','EMPLOYEE_MOVED');
  end if;
  if not exists(
    select 1 from public.employees actor
    where actor.organization_id=target_organization_id
      and actor.employee_id=p_actor_employee_id
      and actor.status='Active'
  ) then
    raise exception 'Người thao tác không thuộc tổ chức.' using errcode='42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'device_id',device.device_id,
    'device_label',device.device_label,
    'activated_at',device.activated_at
  ) order by device.device_id),'[]') into old_devices
  from public.trusted_devices device
  where device.organization_id=target_organization_id
    and device.employee_id=p_employee_id and device.status='ACTIVE';
  update public.trusted_devices
  set status='REVOKED',revoked_at=clock_timestamp(),
      revoked_by=p_actor_employee_id,revoke_reason=left(p_reason,500)
  where organization_id=target_organization_id
    and employee_id=p_employee_id and status='ACTIVE';
  get diagnostics count_reset=row_count;
  delete from public.trusted_device_grants where employee_id=p_employee_id;
  delete from public.trusted_device_challenges where employee_id=p_employee_id;
  update public.employees
  set trusted_device_id=null,trusted_device_bound_at=null,
      updated_at=clock_timestamp()
  where organization_id=target_organization_id and employee_id=p_employee_id;
  insert into public.audit_logs(
    organization_id,actor_employee_id,target_employee_id,action,
    entity_type,entity_id,reason,metadata
  ) values(
    target_organization_id,p_actor_employee_id,p_employee_id,
    'TRUSTED_DEVICE_RESET','trusted_device',p_employee_id,
    left(trim(p_reason),1000),jsonb_build_object(
      'organization_id',target_organization_id,'old_devices',old_devices
    )
  );
  return jsonb_build_object('ok',true,'count',count_reset);
end;
$$;

revoke all on function public.activate_trusted_device_v1(text,text,jsonb,text,text),
  public.create_trusted_device_challenge_v1(text,text,integer),
  public.consume_trusted_device_challenge_v1(uuid,text,text,integer),
  public.reset_trusted_device_v1(text,text,text)
from public,anon,authenticated,service_role;
grant execute on function public.activate_trusted_device_v1(text,text,jsonb,text,text),
  public.create_trusted_device_challenge_v1(text,text,integer),
  public.consume_trusted_device_challenge_v1(uuid,text,text,integer),
  public.reset_trusted_device_v1(text,text,text)
to service_role;

do $verify$
begin
  if exists(
    select 1 from public.shift_assignments
    where scheduled_start is null or scheduled_end is null
  ) then raise exception 'Assignment windows are incomplete.'; end if;
  if exists(
    select 1 from public.timesheets timesheet
    where not exists(select 1 from public.work_sessions session where session.id=timesheet.id)
  ) then raise exception 'Timesheet to work-session backfill is incomplete.'; end if;
  if has_function_privilege('authenticated','public.activate_trusted_device_v1(text,text,jsonb,text,text)','execute')
    or has_function_privilege('authenticated','public.create_trusted_device_challenge_v1(text,text,integer)','execute')
    or has_function_privilege('authenticated','public.consume_trusted_device_challenge_v1(uuid,text,text,integer)','execute')
    or has_function_privilege('authenticated','public.reset_trusted_device_v1(text,text,text)','execute') then
    raise exception 'Device state RPCs must remain service-role only.';
  end if;
end;
$verify$;

notify pgrst,'reload schema';
