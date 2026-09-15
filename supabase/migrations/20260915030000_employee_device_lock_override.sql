-- Per-employee override on top of the DEVICE_LOCK_ROLES policy.
--
-- Three states, not two:
--   null   follow the role policy (the default, and what every existing row gets)
--   true   always lock this person to one device
--   false  never lock this person
--
-- Nullable on purpose. A plain boolean would have to be materialised for all 38
-- existing employees, which would freeze them at today's policy and make every
-- later change to DEVICE_LOCK_ROLES a no-op for everyone already hired.

alter table public.employees
  add column if not exists device_lock_required boolean;

comment on column public.employees.device_lock_required is
  'Per-employee device lock override. NULL follows DEVICE_LOCK_ROLES for the role; true/false force it. A Kiosk account is never locked regardless.';

-- Only the rows that actually override the policy are ever looked at, and they
-- are expected to stay a small minority of the table.
create index if not exists employees_device_lock_override_idx
  on public.employees (organization_id, device_lock_required)
  where device_lock_required is not null;

-- A Kiosk station is shared hardware with no individual owner, so locking one is
-- not a policy choice but a contradiction. Reject it at the write instead of
-- silently ignoring it later.
create or replace function wf_private.validate_employee_device_lock()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.role = 'Kiosk' and new.device_lock_required is true then
    raise exception 'Tài khoản Kiosk không thể bị khóa thiết bị.' using errcode='22023';
  end if;
  return new;
end;
$$;

revoke all on function wf_private.validate_employee_device_lock()
from public, anon, authenticated;

drop trigger if exists employees_validate_device_lock on public.employees;
create trigger employees_validate_device_lock
before insert or update of role, device_lock_required on public.employees
for each row execute function wf_private.validate_employee_device_lock();

notify pgrst, 'reload schema';
