-- The attendance command demanded a live trusted-device grant from every role,
-- while DEVICE_LOCK_ROLES lets a role be exempt from ever binding one. An exempt
-- employee therefore had no grant, could never obtain one, and could never clock
-- in: the check-in failed with DEVICE_NOT_VERIFIED forever.
--
-- The policy has to mean one thing in both places. A role that is not device
-- locked is not asked to prove a device at check-in either; a locked role is
-- unchanged and still needs a valid, unexpired grant on the exact device.

create or replace function wf_private.device_lock_required(p_employee_id text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  target public.employees%rowtype;
  configured text;
  locked_roles jsonb;
  fallback constant jsonb := '["Staff","Leader","Manager","Director","HR"]'::jsonb;
begin
  select * into target from public.employees where employee_id = p_employee_id;
  -- An unknown employee is never waved through.
  if target.employee_id is null then return true; end if;
  -- Shared hardware has no individual owner to bind.
  if target.role = 'Kiosk' then return false; end if;
  -- An explicit per-employee decision outranks the role policy in both directions.
  if target.device_lock_required is not null then return target.device_lock_required; end if;

  select setting.value into configured
  from public.config_system setting
  where setting.organization_id = target.organization_id
    and setting.key = 'DEVICE_LOCK_ROLES';

  begin
    locked_roles := coalesce(configured, fallback::text)::jsonb;
  exception when others then
    locked_roles := fallback;
  end;
  -- Fail closed: an unreadable policy keeps device proof required rather than
  -- handing out an exemption nobody granted.
  if jsonb_typeof(locked_roles) is distinct from 'array' then
    locked_roles := fallback;
  end if;

  return exists(
    select 1 from jsonb_array_elements_text(locked_roles) configured_role(role)
    where configured_role.role = target.role
  );
end;
$$;

revoke all on function wf_private.device_lock_required(text)
from public, anon, authenticated;

-- Patch the one fragment rather than restating a very large function. The helper
-- asserts it appears exactly once, so a future rewrite of wf_private.attendance
-- fails this migration loudly instead of silently leaving exempt roles locked out.
create function wf_private.patch_attendance_device_fragment(
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
  select pg_catalog.pg_get_functiondef(p_signature) into definition;
  occurrences := (length(definition) - length(replace(definition, p_old, ''))) / length(p_old);
  if occurrences <> 1 then
    raise exception 'Expected one occurrence in %, found %', p_signature, occurrences;
  end if;
  execute replace(definition, p_old, p_new);
end;
$$;

select wf_private.patch_attendance_device_fragment(
  'wf_private.attendance(jsonb)'::regprocedure,
  $old$device_ok:=exists($old$,
  $new$device_ok:=(not wf_private.device_lock_required(actor.employee_id)) or exists($new$
);

drop function wf_private.patch_attendance_device_fragment(regprocedure, text, text);

notify pgrst, 'reload schema';
