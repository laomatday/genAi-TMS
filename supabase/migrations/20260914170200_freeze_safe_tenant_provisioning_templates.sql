-- Provisioning must not clone mutable customer configuration. Snapshot the
-- platform baseline into private template tables once, preserve capability
-- enabled/deny state, and validate every legacy APPROVAL_ROLES row before use.
set local lock_timeout='5s';
set local statement_timeout='120s';

create table if not exists wf_private.tenant_shift_templates(
  name text primary key,
  start_time time not null,
  end_time time not null,
  break_point time,
  sort_order integer not null,
  active boolean not null
);
create table if not exists wf_private.tenant_system_templates(
  key text primary key,
  value text not null
);
create table if not exists wf_private.tenant_capability_templates(
  role text not null,
  capability text not null,
  enabled boolean not null,
  primary key(role,capability)
);

revoke all on table wf_private.tenant_shift_templates,
  wf_private.tenant_system_templates,
  wf_private.tenant_capability_templates
from public,anon,authenticated,service_role;

do $preflight$
declare
  setting record;
  config jsonb;
begin
  for setting in
    select organization_id,value
    from public.config_system
    where key='APPROVAL_ROLES'
  loop
    begin
      config:=setting.value::jsonb;
    exception when others then
      raise exception 'APPROVAL_ROLES không hợp lệ ở tổ chức %',setting.organization_id
        using errcode='22023';
    end;
    if jsonb_typeof(config)<>'object'
      or jsonb_typeof(config->'leave') is distinct from 'array'
      or jsonb_typeof(config->'attendance') is distinct from 'array' then
      raise exception 'APPROVAL_ROLES sai cấu trúc ở tổ chức %',setting.organization_id
        using errcode='22023';
    end if;
    if exists(
      select 1 from jsonb_array_elements_text(config->'leave') configured(role)
      where configured.role not in ('Leader','Manager','Director','HR')
    ) or exists(
      select 1 from jsonb_array_elements_text(config->'attendance') configured(role)
      where configured.role not in ('Leader','Manager','Director','HR')
    ) then
      raise exception 'APPROVAL_ROLES chứa vai trò không được phép ở tổ chức %',setting.organization_id
        using errcode='22023';
    end if;
  end loop;
end;
$preflight$;

insert into wf_private.tenant_shift_templates(
  name,start_time,end_time,break_point,sort_order,active
)
select name,start_time,end_time,break_point,sort_order,active
from public.config_shifts
where organization_id=wf_private.default_organization()
on conflict(name) do nothing;

insert into wf_private.tenant_system_templates(key,value)
select key,value
from public.config_system
where organization_id=wf_private.default_organization()
on conflict(key) do nothing;

insert into wf_private.tenant_capability_templates(role,capability,enabled)
select role,capability,enabled
from public.workforce_role_capabilities
where organization_id=wf_private.default_organization()
on conflict(role,capability) do nothing;

create or replace function wf_private.validate_approval_roles_configuration()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
declare config jsonb;
begin
  if new.key<>'APPROVAL_ROLES' then return new; end if;
  begin
    config:=new.value::jsonb;
  exception when others then
    raise exception 'APPROVAL_ROLES phải là JSON hợp lệ.' using errcode='22023';
  end;
  if jsonb_typeof(config)<>'object'
    or jsonb_typeof(config->'leave') is distinct from 'array'
    or jsonb_typeof(config->'attendance') is distinct from 'array' then
    raise exception 'APPROVAL_ROLES phải có hai danh sách role hợp lệ: leave và attendance.'
      using errcode='22023';
  end if;
  if exists(
    select 1 from jsonb_array_elements_text(config->'leave') configured(role)
    where configured.role not in ('Leader','Manager','Director','HR')
  ) or exists(
    select 1 from jsonb_array_elements_text(config->'attendance') configured(role)
    where configured.role not in ('Leader','Manager','Director','HR')
  ) then
    raise exception 'APPROVAL_ROLES chứa vai trò không được phép.' using errcode='22023';
  end if;
  return new;
end;
$$;
revoke all on function wf_private.validate_approval_roles_configuration()
from public,anon,authenticated,service_role;

create or replace function wf_private.approval_role_configured(
  p_organization_id uuid,
  p_role text,
  p_request_type text
)
returns boolean
language plpgsql
stable
security definer
set search_path=''
as $$
declare raw_config text; config jsonb; family text;
begin
  if p_role='Admin' then return true; end if;
  family:=case when p_request_type in ('EXPLANATION','CORRECTION') then 'attendance' else 'leave' end;
  select setting.value into raw_config
  from public.config_system setting
  where setting.organization_id=p_organization_id and setting.key='APPROVAL_ROLES';
  if not found then return p_role in ('Manager','Director','HR'); end if;
  if raw_config is null then return false; end if;
  begin config:=raw_config::jsonb; exception when others then return false; end;
  if jsonb_typeof(config)<>'object'
    or jsonb_typeof(config->'leave') is distinct from 'array'
    or jsonb_typeof(config->'attendance') is distinct from 'array' then
    return false;
  end if;
  if exists(
    select 1 from jsonb_array_elements_text(config->'leave') configured(role)
    where configured.role not in ('Leader','Manager','Director','HR')
  ) or exists(
    select 1 from jsonb_array_elements_text(config->'attendance') configured(role)
    where configured.role not in ('Leader','Manager','Director','HR')
  ) then
    return false;
  end if;
  return exists(
    select 1 from jsonb_array_elements_text(config->family) configured(role)
    where configured.role=p_role
  );
end;
$$;
revoke all on function wf_private.approval_role_configured(uuid,text,text)
from public,anon,authenticated,service_role;

create or replace function wf_private.seed_organization_configuration()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
begin
  insert into public.config_shifts(
    organization_id,name,start_time,end_time,break_point,sort_order,active
  )
  select new.id,name,start_time,end_time,break_point,sort_order,active
  from wf_private.tenant_shift_templates
  on conflict(organization_id,name) do nothing;

  insert into public.config_system(organization_id,key,value,updated_at)
  select new.id,key,value,clock_timestamp()
  from wf_private.tenant_system_templates
  on conflict(organization_id,key) do nothing;

  insert into public.workforce_role_capabilities(
    organization_id,role,capability,enabled
  )
  select new.id,role,capability,enabled
  from wf_private.tenant_capability_templates
  on conflict(organization_id,role,capability) do nothing;

  insert into public.workforce_request_counters(organization_id,next_value)
  values(new.id,1)
  on conflict(organization_id) do nothing;

  insert into public.attendance_policies(organization_id,name)
  values(new.id,'Chuẩn văn phòng')
  on conflict(organization_id,name) do nothing;
  return new;
end;
$$;
revoke all on function wf_private.seed_organization_configuration()
from public,anon,authenticated,service_role;

notify pgrst,'reload schema';
