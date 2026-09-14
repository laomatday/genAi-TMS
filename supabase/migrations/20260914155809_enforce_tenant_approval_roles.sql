-- Approval roles configured by an organization are authoritative in the
-- database. The existing command capability/scope/revision checks still apply;
-- this trigger adds the missing request-family policy check.
set local lock_timeout = '5s';
set local statement_timeout = '120s';

create or replace function wf_private.approval_role_allowed(
  p_organization_id uuid,
  p_request_type text
)
returns boolean
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  actor_role text;
  actor_organization uuid;
  raw_config text;
  config jsonb;
  family text;
  configured_roles jsonb;
begin
  select employee.role,employee.organization_id
  into actor_role,actor_organization
  from public.employees employee
  where employee.auth_user_id=(select auth.uid())
    and employee.status='Active'
  limit 1;

  if actor_role is null or actor_organization<>p_organization_id then
    return false;
  end if;
  if actor_role='Admin' then
    return true;
  end if;

  family := case
    when p_request_type in ('EXPLANATION','CORRECTION') then 'attendance'
    else 'leave'
  end;

  select setting.value
  into raw_config
  from public.config_system setting
  where setting.organization_id=p_organization_id
    and setting.key='APPROVAL_ROLES';

  if raw_config is null then
    return actor_role in ('Manager','Director','HR');
  end if;

  begin
    config := raw_config::jsonb;
  exception when others then
    raise exception 'Cấu hình APPROVAL_ROLES không hợp lệ.';
  end;

  configured_roles := config->family;
  if configured_roles is null or jsonb_typeof(configured_roles)<>'array' then
    return actor_role in ('Manager','Director','HR');
  end if;

  return exists(
    select 1
    from jsonb_array_elements_text(configured_roles) configured(role)
    where configured.role=actor_role
  );
end;
$$;

revoke all on function wf_private.approval_role_allowed(uuid,text)
from public,anon,authenticated;

create or replace function wf_private.enforce_approval_role_policy()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
begin
  if old.status='PENDING'
    and new.status in ('APPROVED','REJECTED')
    and (select auth.uid()) is not null
    and not wf_private.approval_role_allowed(
      new.organization_id,
      new.request_type
    ) then
    raise exception 'Vai trò hiện tại không được cấu hình để duyệt loại yêu cầu này.'
      using errcode='42501';
  end if;
  return new;
end;
$$;

revoke all on function wf_private.enforce_approval_role_policy()
from public,anon,authenticated;

create trigger attendance_requests_enforce_approval_role
before update of status on public.attendance_requests
for each row execute function wf_private.enforce_approval_role_policy();

notify pgrst, 'reload schema';
