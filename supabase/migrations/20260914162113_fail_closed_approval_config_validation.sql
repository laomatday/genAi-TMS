-- JSON path comparisons return SQL null for a missing family. Use
-- IS DISTINCT FROM so an existing but incomplete configuration fails closed.
set local lock_timeout='5s';
set local statement_timeout='120s';

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
  if actor_role='Admin' then return true; end if;

  family := case
    when p_request_type in ('EXPLANATION','CORRECTION') then 'attendance'
    else 'leave'
  end;

  select setting.value
  into raw_config
  from public.config_system setting
  where setting.organization_id=p_organization_id
    and setting.key='APPROVAL_ROLES';

  if not found then
    return actor_role in ('Manager','Director','HR');
  end if;
  if raw_config is null then return false; end if;

  begin
    config := raw_config::jsonb;
  exception when others then
    return false;
  end;

  if jsonb_typeof(config) is distinct from 'object'
    or jsonb_typeof(config->'leave') is distinct from 'array'
    or jsonb_typeof(config->'attendance') is distinct from 'array'
    or exists(
      select 1
      from jsonb_array_elements_text(config->'leave') configured(role)
      where configured.role not in ('Leader','Manager','Director','HR')
    )
    or exists(
      select 1
      from jsonb_array_elements_text(config->'attendance') configured(role)
      where configured.role not in ('Leader','Manager','Director','HR')
    ) then
    return false;
  end if;

  configured_roles := config->family;
  return exists(
    select 1
    from jsonb_array_elements_text(configured_roles) configured(role)
    where configured.role=actor_role
  );
end;
$$;

revoke all on function wf_private.approval_role_allowed(uuid,text)
from public,anon;
grant execute on function wf_private.approval_role_allowed(uuid,text)
to authenticated;

create or replace function wf_private.validate_approval_roles_configuration()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
declare
  config jsonb;
begin
  if new.key<>'APPROVAL_ROLES' then return new; end if;
  begin
    config := new.value::jsonb;
  exception when others then
    raise exception 'APPROVAL_ROLES phải là JSON hợp lệ.' using errcode='22023';
  end;
  if jsonb_typeof(config) is distinct from 'object'
    or jsonb_typeof(config->'leave') is distinct from 'array'
    or jsonb_typeof(config->'attendance') is distinct from 'array'
    or exists(
      select 1
      from jsonb_array_elements_text(config->'leave') configured(role)
      where configured.role not in ('Leader','Manager','Director','HR')
    )
    or exists(
      select 1
      from jsonb_array_elements_text(config->'attendance') configured(role)
      where configured.role not in ('Leader','Manager','Director','HR')
    ) then
    raise exception 'APPROVAL_ROLES phải có hai danh sách role hợp lệ: leave và attendance.'
      using errcode='22023';
  end if;
  return new;
end;
$$;

revoke all on function wf_private.validate_approval_roles_configuration()
from public,anon,authenticated;

notify pgrst,'reload schema';
