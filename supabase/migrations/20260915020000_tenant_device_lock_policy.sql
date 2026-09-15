-- Which roles must bind a trusted device becomes tenant configuration instead of
-- a constant compiled into the bundle.
--
-- `activate_trusted_device_v1` already refuses to bind one device to a second
-- employee (DEVICE_ID_CONFLICT) and one employee to a second device
-- (DEVICE_ALREADY_BOUND). Those rules only ever apply to a role that binds at
-- all, so unlocking a role here is what lets that role sign in from any device —
-- the administrator's way back in when a phone is lost or a binding is stuck.
--
-- Kiosk is absent from every list on purpose: a station is shared hardware with
-- no individual owner, so there is nothing to bind.

insert into public.config_system(organization_id, key, value, updated_at)
select
  organization.id,
  'DEVICE_LOCK_ROLES',
  '["Staff","Leader","Manager","Director","HR"]',
  clock_timestamp()
from public.organizations organization
on conflict (organization_id, key) do nothing;

create or replace function wf_private.validate_device_lock_roles_configuration()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  config jsonb;
begin
  if new.key <> 'DEVICE_LOCK_ROLES' then return new; end if;
  begin
    config := new.value::jsonb;
  exception when others then
    raise exception 'DEVICE_LOCK_ROLES phải là JSON hợp lệ.' using errcode='22023';
  end;
  -- Fail closed on anything unreadable: a malformed value must be rejected at the
  -- write rather than quietly read later as "no role is locked".
  if jsonb_typeof(config) is distinct from 'array'
    or exists(
      select 1
      from jsonb_array_elements_text(config) configured(role)
      where configured.role not in ('Staff','Leader','Manager','Director','HR','Admin')
    ) then
    raise exception 'DEVICE_LOCK_ROLES phải là danh sách role hợp lệ; Kiosk không bao giờ khóa thiết bị.'
      using errcode='22023';
  end if;
  return new;
end;
$$;

revoke all on function wf_private.validate_device_lock_roles_configuration()
from public, anon, authenticated;

drop trigger if exists config_system_validate_device_lock_roles on public.config_system;
create trigger config_system_validate_device_lock_roles
before insert or update of key,value on public.config_system
for each row execute function wf_private.validate_device_lock_roles_configuration();

-- The Control Center writes settings through wf_private.config_patch, which only
-- accepts an allow-listed set of keys. Without this the new panel would be
-- refused at save time. Rather than restate that very large function, patch the
-- one fragment: the helper asserts it appears exactly once, so a future rewrite
-- of config_patch fails this migration loudly instead of silently leaving the key
-- unwritable. The helper is scoped to this migration and dropped again below.
create function wf_private.patch_device_lock_fragment(
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

select wf_private.patch_device_lock_fragment(
  'wf_private.config_patch(jsonb)'::regprocedure,
  $old$'QR_REFRESH_SECONDS','QR_VALIDITY_SECONDS','APPROVAL_ROLES'$old$,
  $new$'QR_REFRESH_SECONDS','QR_VALIDITY_SECONDS','APPROVAL_ROLES','DEVICE_LOCK_ROLES'$new$
);

drop function wf_private.patch_device_lock_fragment(regprocedure, text, text);

-- The policy is read by the trusted-device Edge Function through the service
-- role, the same way it already reads `employees` and `attendance_policies`. It
-- is deliberately not exposed as an RPC: the browser must never be able to ask,
-- or answer, whether its own role is exempt.
--
-- Read only. Configuration is still written exclusively through
-- wf_private.config_patch, so the Edge Function cannot rewrite the policy it is
-- being judged by.
grant select on public.config_system to service_role;

notify pgrst, 'reload schema';
