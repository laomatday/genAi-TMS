-- Commercial multi-tenant boundary for shifts, holidays and system settings.
-- Tenant identity is always derived from the authenticated employee; browser
-- payloads are never trusted to choose an organization.
set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- --------------------------------------------------------------------------
-- 1. Backfill the original single-organization configuration.
-- --------------------------------------------------------------------------
alter table public.config_shifts
  add column organization_id uuid references public.organizations(id);
alter table public.config_system
  add column organization_id uuid references public.organizations(id);
alter table public.holidays
  add column organization_id uuid references public.organizations(id);

update public.config_shifts
set organization_id = wf_private.default_organization()
where organization_id is null;
update public.config_system
set organization_id = wf_private.default_organization()
where organization_id is null;
update public.holidays
set organization_id = wf_private.default_organization()
where organization_id is null;

alter table public.config_shifts
  alter column organization_id set not null,
  alter column organization_id set default tms_private.request_organization();
alter table public.config_system
  alter column organization_id set not null,
  alter column organization_id set default tms_private.request_organization();
alter table public.holidays
  alter column organization_id set not null,
  alter column organization_id set default tms_private.request_organization();

alter table public.config_shifts drop constraint if exists config_shifts_name_key;
alter table public.config_shifts
  add constraint config_shifts_organization_name_key unique (organization_id, name),
  add constraint config_shifts_organization_id_key unique (organization_id, id);

alter table public.config_system drop constraint if exists config_system_pkey;
alter table public.config_system
  add constraint config_system_pkey primary key (organization_id, key);

alter table public.holidays
  add constraint holidays_organization_id_key unique (organization_id, id);

create index config_shifts_organization_active_idx
  on public.config_shifts (organization_id, active, sort_order, id);
create index config_system_organization_key_idx
  on public.config_system (organization_id, key);
create index holidays_organization_dates_idx
  on public.holidays (organization_id, active, from_date, to_date);

-- A schedule row and staffing rule can only reference a shift belonging to the
-- same organization. The original single-column foreign keys remain as an
-- additional integrity check because shift ids are globally generated.
alter table public.shift_assignments
  add constraint shift_assignments_organization_shift_fk
  foreign key (organization_id, shift_id)
  references public.config_shifts (organization_id, id)
  on update cascade on delete restrict;

alter table public.workforce_staffing_rules
  add constraint workforce_staffing_rules_organization_shift_fk
  foreign key (organization_id, shift_id)
  references public.config_shifts (organization_id, id)
  on update cascade on delete restrict;

-- --------------------------------------------------------------------------
-- 2. Explicit Data API grants and tenant-scoped RLS policies.
-- --------------------------------------------------------------------------
alter table public.config_shifts enable row level security;
alter table public.config_system enable row level security;
alter table public.holidays enable row level security;

revoke all on table public.config_shifts, public.config_system, public.holidays
  from public, anon, authenticated;
grant select, insert, update on table public.config_shifts, public.config_system, public.holidays
  to authenticated;
grant select, insert, update, delete on table public.config_shifts, public.config_system, public.holidays
  to service_role;
grant usage, select on sequence public.config_shifts_id_seq, public.holidays_id_seq
  to authenticated, service_role;

drop policy if exists authenticated_reads_active_shifts on public.config_shifts;
drop policy if exists admin_inserts_shifts on public.config_shifts;
drop policy if exists admin_updates_shifts on public.config_shifts;
drop policy if exists config_shifts_read_tenant on public.config_shifts;
drop policy if exists config_shifts_insert_tenant on public.config_shifts;
drop policy if exists config_shifts_update_tenant on public.config_shifts;

create policy config_shifts_read_tenant
on public.config_shifts for select to authenticated
using (
  organization_id = (select wf_private.current_organization())
  and (active or (select tms_private.is_admin_operator()))
);
create policy config_shifts_insert_tenant
on public.config_shifts for insert to authenticated
with check (
  (select tms_private.is_admin())
  and organization_id = (select wf_private.current_organization())
);
create policy config_shifts_update_tenant
on public.config_shifts for update to authenticated
using (
  (select tms_private.is_admin())
  and organization_id = (select wf_private.current_organization())
)
with check (
  (select tms_private.is_admin())
  and organization_id = (select wf_private.current_organization())
);

drop policy if exists authenticated_reads_system_config on public.config_system;
drop policy if exists admin_inserts_system_config on public.config_system;
drop policy if exists admin_updates_system_config on public.config_system;
drop policy if exists config_system_read_tenant on public.config_system;
drop policy if exists config_system_insert_tenant on public.config_system;
drop policy if exists config_system_update_tenant on public.config_system;

create policy config_system_read_tenant
on public.config_system for select to authenticated
using (organization_id = (select wf_private.current_organization()));
create policy config_system_insert_tenant
on public.config_system for insert to authenticated
with check (
  (select tms_private.is_admin())
  and organization_id = (select wf_private.current_organization())
);
create policy config_system_update_tenant
on public.config_system for update to authenticated
using (
  (select tms_private.is_admin())
  and organization_id = (select wf_private.current_organization())
)
with check (
  (select tms_private.is_admin())
  and organization_id = (select wf_private.current_organization())
);

drop policy if exists holidays_read on public.holidays;
drop policy if exists holidays_admin_insert on public.holidays;
drop policy if exists holidays_admin_update on public.holidays;
drop policy if exists holidays_admin_delete on public.holidays;
drop policy if exists holidays_read_tenant on public.holidays;
drop policy if exists holidays_insert_tenant on public.holidays;
drop policy if exists holidays_update_tenant on public.holidays;
drop policy if exists holidays_delete_tenant on public.holidays;

create policy holidays_read_tenant
on public.holidays for select to authenticated
using (
  organization_id = (select wf_private.current_organization())
  and (active or (select tms_private.is_admin_operator()))
);
create policy holidays_insert_tenant
on public.holidays for insert to authenticated
with check (
  (select tms_private.is_admin())
  and organization_id = (select wf_private.current_organization())
);
create policy holidays_update_tenant
on public.holidays for update to authenticated
using (
  (select tms_private.is_admin())
  and organization_id = (select wf_private.current_organization())
)
with check (
  (select tms_private.is_admin())
  and organization_id = (select wf_private.current_organization())
);
create policy holidays_delete_tenant
on public.holidays for delete to authenticated
using (
  (select tms_private.is_admin())
  and organization_id = (select wf_private.current_organization())
);

-- Organizations are visible only as the caller's own tenant. Creation remains
-- a service-role provisioning operation, never a browser action.
alter table public.organizations enable row level security;
revoke all on table public.organizations from public, anon, authenticated;
grant select on table public.organizations to authenticated;
grant select, insert, update on table public.organizations to service_role;
drop policy if exists organizations_read_tenant on public.organizations;
create policy organizations_read_tenant
on public.organizations for select to authenticated
using (id = (select wf_private.current_organization()));

-- --------------------------------------------------------------------------
-- 3. Human-readable request references, issued atomically per tenant.
-- --------------------------------------------------------------------------
create table public.workforce_request_counters (
  organization_id uuid primary key references public.organizations(id) on delete restrict,
  next_value bigint not null default 1 check (next_value > 0),
  updated_at timestamptz not null default clock_timestamp()
);
alter table public.workforce_request_counters enable row level security;
revoke all on table public.workforce_request_counters from public, anon, authenticated;
grant select, insert, update on table public.workforce_request_counters to service_role;

alter table public.attendance_requests add column request_code text;

with ranked as (
  select id,
    'REQ-' || lpad(
      row_number() over (partition by organization_id order by created_at, id)::text,
      6,
      '0'
    ) as request_code
  from public.attendance_requests
)
update public.attendance_requests request
set request_code = ranked.request_code
from ranked
where ranked.id = request.id;

insert into public.workforce_request_counters (organization_id, next_value)
select organization_id, count(*) + 1
from public.attendance_requests
group by organization_id
on conflict (organization_id) do update
set next_value = excluded.next_value,
    updated_at = clock_timestamp();

create or replace function wf_private.assign_request_code()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  sequence_value bigint;
begin
  if new.organization_id is null then
    select employee.organization_id into new.organization_id
    from public.employees employee
    where employee.employee_id = new.employee_id;
  end if;
  if new.organization_id is null then
    raise exception 'Không xác định được tổ chức của yêu cầu.' using errcode = '23502';
  end if;

  insert into public.workforce_request_counters (organization_id, next_value)
  values (new.organization_id, 1)
  on conflict (organization_id) do nothing;

  update public.workforce_request_counters
  set next_value = next_value + 1,
      updated_at = clock_timestamp()
  where organization_id = new.organization_id
  returning next_value - 1 into sequence_value;

  new.request_code := 'REQ-' || lpad(
    sequence_value::text,
    greatest(6, length(sequence_value::text)),
    '0'
  );
  return new;
end;
$$;
revoke all on function wf_private.assign_request_code() from public, anon, authenticated;

create trigger workforce_request_code
before insert on public.attendance_requests
for each row execute function wf_private.assign_request_code();

alter table public.attendance_requests
  alter column request_code set not null,
  add constraint attendance_requests_organization_request_code_key
    unique (organization_id, request_code),
  add constraint attendance_requests_request_code_check
    check (request_code ~ '^REQ-[0-9]{6,}$');

create index attendance_requests_request_code_idx
  on public.attendance_requests (request_code);

-- --------------------------------------------------------------------------
-- 4. Initialize safe defaults when the service role provisions a new tenant.
-- --------------------------------------------------------------------------
create or replace function wf_private.seed_organization_configuration()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.config_shifts (
    organization_id, name, start_time, end_time, break_point, sort_order, active
  )
  select new.id, name, start_time, end_time, break_point, sort_order, active
  from public.config_shifts
  where organization_id = wf_private.default_organization()
  on conflict (organization_id, name) do nothing;

  insert into public.config_system (organization_id, key, value, updated_at)
  select new.id, key, value, clock_timestamp()
  from public.config_system
  where organization_id = wf_private.default_organization()
  on conflict (organization_id, key) do nothing;

  insert into public.workforce_role_capabilities (organization_id, role, capability)
  select new.id, role, capability
  from public.workforce_role_capabilities
  where organization_id = wf_private.default_organization()
  on conflict (organization_id, role, capability) do nothing;

  insert into public.workforce_request_counters (organization_id, next_value)
  values (new.id, 1)
  on conflict (organization_id) do nothing;
  return new;
end;
$$;
revoke all on function wf_private.seed_organization_configuration() from public, anon, authenticated;

create trigger workforce_seed_organization_configuration
after insert on public.organizations
for each row execute function wf_private.seed_organization_configuration();

-- --------------------------------------------------------------------------
-- 5. Patch every active SECURITY DEFINER path that reads tenant configuration.
-- The helper is guarded: a changed or missing source fragment aborts the whole
-- migration instead of leaving one RPC partially tenantized.
-- --------------------------------------------------------------------------
create function wf_private.patch_function_fragment(
  p_signature regprocedure,
  p_old text,
  p_new text
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  definition text;
  occurrences integer;
begin
  if p_old is null or p_old = '' then
    raise exception 'Empty function patch fragment';
  end if;
  select pg_catalog.pg_get_functiondef(p_signature) into definition;
  occurrences := (
    length(definition) - length(replace(definition, p_old, ''))
  ) / length(p_old);
  if occurrences <> 1 then
    raise exception 'Expected one occurrence in %, found %', p_signature, occurrences;
  end if;
  execute replace(definition, p_old, p_new);
end;
$$;
revoke all on function wf_private.patch_function_fragment(regprocedure, text, text)
  from public, anon, authenticated;

select wf_private.patch_function_fragment(
  'wf_private.attendance(jsonb)'::regprocedure,
  $old$select * into assignment from public.shift_assignments where employee_id=a.employee_id and work_date=day and publication_status='PUBLISHED';$old$,
  $new$select * into assignment from public.shift_assignments where employee_id=a.employee_id and work_date=day and organization_id=a.organization_id and publication_status='PUBLISHED';$new$
);
select wf_private.patch_function_fragment(
  'wf_private.attendance(jsonb)'::regprocedure,
  $old$select * into shift from public.config_shifts where id=assignment.shift_id and active;$old$,
  $new$select * into shift from public.config_shifts where id=assignment.shift_id and organization_id=a.organization_id and active;$new$
);

select wf_private.patch_function_fragment(
  'tms_private.apply_assigned_shift_to_timesheet()'::regprocedure,
  $old$select * into s from public.config_shifts where id=a.shift_id;$old$,
  $new$select * into s from public.config_shifts where id=a.shift_id and organization_id=a.organization_id;$new$
);

select wf_private.patch_function_fragment(
  'wf_private.schedule_save(jsonb)'::regprocedure,
  $old$select * into e from public.employees where employee_id=item->>'employee_id' and status='Active' and role<>'Kiosk';$old$,
  $new$select * into e from public.employees where employee_id=item->>'employee_id' and organization_id=a.organization_id and status='Active' and role<>'Kiosk';$new$
);
select wf_private.patch_function_fragment(
  'wf_private.schedule_save(jsonb)'::regprocedure,
  $old$select * into s from public.config_shifts where id=(item->>'shift_id')::bigint and active;$old$,
  $new$select * into s from public.config_shifts where id=(item->>'shift_id')::bigint and organization_id=a.organization_id and active;$new$
);
select wf_private.patch_function_fragment(
  'wf_private.schedule_save(jsonb)'::regprocedure,
  $old$from public.shift_assignments sa join public.config_shifts cs on cs.id=sa.shift_id
    where sa.employee_id=e.employee_id$old$,
  $new$from public.shift_assignments sa join public.config_shifts cs on cs.id=sa.shift_id and cs.organization_id=sa.organization_id
    where sa.organization_id=a.organization_id and sa.employee_id=e.employee_id$new$
);

select wf_private.patch_function_fragment(
  'wf_private.schedule_command(text,jsonb)'::regprocedure,
  $old$not exists(select 1 from public.config_shifts where id=(entry->>'shift_id')::bigint and active)$old$,
  $new$not exists(select 1 from public.config_shifts where id=(entry->>'shift_id')::bigint and organization_id=a.organization_id and active)$new$
);
select wf_private.patch_function_fragment(
  'wf_private.schedule_command(text,jsonb)'::regprocedure,
  $old$if not wf_private.capable('team.read_all') and not((p->>'location_id')=any(a.managed_locations)) then raise exception 'Địa điểm ngoài phạm vi.' using errcode='42501'; end if;
  insert into public.workforce_staffing_rules$old$,
  $new$if not wf_private.capable('team.read_all') and not((p->>'location_id')=any(a.managed_locations)) then raise exception 'Địa điểm ngoài phạm vi.' using errcode='42501'; end if;
  if not exists(select 1 from public.config_shifts where id=(p->>'shift_id')::bigint and organization_id=a.organization_id and active) then raise exception 'Ca làm không hợp lệ.'; end if;
  insert into public.workforce_staffing_rules$new$
);
select wf_private.patch_function_fragment(
  'wf_private.schedule_command(text,jsonb)'::regprocedure,
  $old$select * into s from public.config_shifts where id=sa.shift_id and active;$old$,
  $new$select * into s from public.config_shifts where id=sa.shift_id and organization_id=a.organization_id and active;$new$
);

select wf_private.patch_function_fragment(
  'wf_private.review_request(jsonb)'::regprocedure,
  $old$not exists(select 1 from public.holidays h where h.active and g::date between h.from_date and h.to_date)$old$,
  $new$not exists(select 1 from public.holidays h where h.organization_id=a.organization_id and h.active and g::date between h.from_date and h.to_date)$new$
);

select wf_private.patch_function_fragment(
  'wf_private.maintain(uuid)'::regprocedure,
  $old$select * into s from public.config_shifts where id=sa.shift_id;$old$,
  $new$select * into s from public.config_shifts where id=sa.shift_id and organization_id=e.organization_id;$new$
);
select wf_private.patch_function_fragment(
  'wf_private.maintain(uuid)'::regprocedure,
  $old$exists(select 1 from public.holidays h where h.active and d between h.from_date and h.to_date)$old$,
  $new$exists(select 1 from public.holidays h where h.organization_id=e.organization_id and h.active and d between h.from_date and h.to_date)$new$
);

select wf_private.patch_function_fragment(
  'wf_private.query(text,jsonb)'::regprocedure,
  $old$if planned_assignment.id is not null then select * into shift from public.config_shifts where id=planned_assignment.shift_id; end if;$old$,
  $new$if planned_assignment.id is not null then select * into shift from public.config_shifts where id=planned_assignment.shift_id and organization_id=a.organization_id; end if;$new$
);
select wf_private.patch_function_fragment(
  'wf_private.query(text,jsonb)'::regprocedure,
  $old$from public.shift_assignments sa join public.employees e using(employee_id) join public.config_shifts s on s.id=sa.shift_id left join public.locations l on l.center_id=sa.location_id$old$,
  $new$from public.shift_assignments sa join public.employees e using(employee_id) join public.config_shifts s on s.id=sa.shift_id and s.organization_id=sa.organization_id left join public.locations l on l.center_id=sa.location_id$new$
);
select wf_private.patch_function_fragment(
  'wf_private.query(text,jsonb)'::regprocedure,
  $old$from public.config_shifts s where s.active)$old$,
  $new$from public.config_shifts s where s.organization_id=a.organization_id and s.active)$new$
);
select wf_private.patch_function_fragment(
  'wf_private.query(text,jsonb)'::regprocedure,
  $old$from public.holidays h where active and to_date>=today-366 and from_date<=today+366)$old$,
  $new$from public.holidays h where h.organization_id=a.organization_id and active and to_date>=today-366 and from_date<=today+366)$new$
);
select wf_private.patch_function_fragment(
  'wf_private.query(text,jsonb)'::regprocedure,
  $old$from public.workforce_staffing_rules r join public.locations l on l.center_id=r.location_id join public.config_shifts s on s.id=r.shift_id$old$,
  $new$from public.workforce_staffing_rules r join public.locations l on l.center_id=r.location_id join public.config_shifts s on s.id=r.shift_id and s.organization_id=r.organization_id$new$
);
select wf_private.patch_function_fragment(
  'wf_private.query(text,jsonb)'::regprocedure,
  $old$'devices','[]'::jsonb,'shifts',(select coalesce(jsonb_agg(to_jsonb(x)),'[]') from public.config_shifts x),
   'systemSettings',(select coalesce(jsonb_agg(to_jsonb(x)),'[]') from public.config_system x),
   'holidays',(select coalesce(jsonb_agg(to_jsonb(x)),'[]') from public.holidays x),$old$,
  $new$'devices','[]'::jsonb,'shifts',(select coalesce(jsonb_agg(to_jsonb(x)),'[]') from public.config_shifts x where x.organization_id=a.organization_id),
   'systemSettings',(select coalesce(jsonb_agg(to_jsonb(x)),'[]') from public.config_system x where x.organization_id=a.organization_id),
   'holidays',(select coalesce(jsonb_agg(to_jsonb(x)),'[]') from public.holidays x where x.organization_id=a.organization_id),$new$
);

select wf_private.patch_function_fragment(
  'tms_private.create_attendance_qr_v1(text)'::regprocedure,
  $old$where key = 'QR_VALIDITY_SECONDS' and value ~ '^[0-9]+$';$old$,
  $new$where organization_id = actor.organization_id and key = 'QR_VALIDITY_SECONDS' and value ~ '^[0-9]+$';$new$
);

drop function wf_private.patch_function_fragment(regprocedure, text, text);

create or replace function wf_private.guard_configuration()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  row_organization uuid;
begin
  row_organization := (
    case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end
    ->> 'organization_id'
  )::uuid;
  if row_organization is null then
    raise exception 'Configuration row requires an organization.' using errcode = '23502';
  end if;
  if (select auth.uid()) is not null
    and row_organization <> wf_private.current_organization() then
    raise exception 'Configuration belongs to another organization.' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended('workforce-config:' || row_organization::text, 0)
  );
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function wf_private.guard_configuration() from public, anon, authenticated;

-- Workforce V3 replaced these browser-callable legacy routines. They were
-- already fully revoked in the hardening release; remove the dead definitions
-- so database lint cannot hide real errors behind obsolete code.
drop function if exists public.record_qr_attendance(text, double precision, double precision, double precision);
drop function if exists public.record_qr_attendance_v2(text, double precision, double precision, double precision, text);
drop function if exists public.checkout_attendance_gps(double precision, double precision, double precision);
drop function if exists public.record_mobile_checkin(double precision, double precision, double precision, text, text, text);
drop function if exists public.record_mobile_checkout(double precision, double precision, double precision);
drop function if exists public.record_kiosk_checkin(text, text, double precision, double precision, double precision, text);
drop function if exists public.toggle_attendance_pause();
drop function if exists public.toggle_attendance_pause(boolean);
drop function if exists public.get_my_attendance();
drop function if exists public.get_my_tms_v2();
drop function if exists public.sync_my_timesheet_v2();
drop function if exists public.submit_attendance_explanation(date, text);
drop function if exists public.review_attendance_explanation(uuid, text, text);
drop function if exists public.register_or_validate_trusted_device(text);
drop function if exists public.close_attendance_period_v1(date, date, text);
drop function if exists public.lock_timesheets_v2(date);
drop function if exists public.get_employee_directory();
drop function if exists public.save_shift_assignments_v1(jsonb);
drop function if exists public.refresh_tms_exceptions_v2(date, date);
drop function if exists public.delete_shift_assignment_v1(uuid, text);
drop function if exists public.review_attendance_request_v2(uuid, text, text);
drop function if exists public.review_attendance_requests_bulk_v1(jsonb, text, text);
drop function if exists public.review_leave_request(uuid, text, text);
drop function if exists public.submit_attendance_request_v2(uuid, text, text, timestamptz, timestamptz);
drop function if exists public.submit_leave_request(text, date, date, text);

do $$
begin
  if exists (
    select 1
    from pg_indexes
    where schemaname = 'public'
      and tablename = 'leave_requests'
      and indexname = 'leave_requests_id_uidx'
  ) and exists (
    select 1
    from pg_constraint
    where conrelid = 'public.leave_requests'::regclass
      and contype = 'p'
      and pg_get_constraintdef(oid) ~ '\(id\)'
  ) then
    drop index public.leave_requests_id_uidx;
  end if;
end;
$$;

-- --------------------------------------------------------------------------
-- 6. Migration-time invariants. Any partial tenantization aborts atomically.
-- --------------------------------------------------------------------------
do $verify$
declare
  function_source text;
begin
  if exists(select 1 from public.config_shifts where organization_id is null)
    or exists(select 1 from public.config_system where organization_id is null)
    or exists(select 1 from public.holidays where organization_id is null) then
    raise exception 'Configuration tenant backfill is incomplete.';
  end if;
  if exists(
    select 1 from public.shift_assignments assignment
    join public.config_shifts shift on shift.id = assignment.shift_id
    where assignment.organization_id <> shift.organization_id
  ) or exists(
    select 1 from public.workforce_staffing_rules rule
    join public.config_shifts shift on shift.id = rule.shift_id
    where rule.organization_id <> shift.organization_id
  ) then
    raise exception 'Cross-tenant shift reference detected.';
  end if;
  if exists(select 1 from public.attendance_requests where request_code is null)
    or exists(
      select 1 from public.attendance_requests
      group by organization_id, request_code having count(*) > 1
    ) then
    raise exception 'Request business references are incomplete or duplicated.';
  end if;
  if exists(
    select 1
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname in (
        'config_shifts', 'config_system', 'holidays',
        'workforce_request_counters', 'organizations'
      )
      and not relation.relrowsecurity
  ) then
    raise exception 'RLS is missing on a tenant-owned table.';
  end if;

  select pg_catalog.pg_get_functiondef('wf_private.query(text,jsonb)'::regprocedure)
  into function_source;
  if function_source like '%from public.config_shifts s where s.active)%'
    or function_source like '%from public.holidays h where active and%'
    or function_source like '%from public.config_system x),%' then
    raise exception 'Workforce query still contains unscoped configuration reads.';
  end if;
end;
$verify$;

notify pgrst, 'reload schema';
