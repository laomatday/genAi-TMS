-- A tenant approval-role setting controls both mutation and visibility of the
-- reviewer queue. Employees always retain access to their own requests and a
-- shift-swap peer retains access to the consent request.
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

  if not found then
    return actor_role in ('Manager','Director','HR');
  end if;
  if raw_config is null then return false; end if;

  begin
    config := raw_config::jsonb;
  exception when others then
    return false;
  end;

  if jsonb_typeof(config)<>'object'
    or jsonb_typeof(config->'leave')<>'array'
    or jsonb_typeof(config->'attendance')<>'array'
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
  if jsonb_typeof(config)<>'object'
    or jsonb_typeof(config->'leave')<>'array'
    or jsonb_typeof(config->'attendance')<>'array'
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

create trigger config_system_validate_approval_roles
before insert or update of key,value on public.config_system
for each row execute function wf_private.validate_approval_roles_configuration();

drop policy if exists tms_v2_requests_read on public.attendance_requests;
drop policy if exists attendance_requests_read_scoped on public.attendance_requests;
create policy attendance_requests_read_scoped
on public.attendance_requests for select to authenticated
using (
  organization_id = (select wf_private.current_organization())
  and (
    employee_id = (select tms_private.current_employee_id())
    or workflow_data->>'peer_employee_id' = (select tms_private.current_employee_id())
    or (
      (select tms_private.can_manage_employee(employee_id))
      and (select wf_private.approval_role_allowed(organization_id,request_type))
    )
  )
);

-- workforce_query is SECURITY DEFINER, so RLS alone cannot protect its team
-- branch. Patch the two request predicates with an occurrence guard; any drift
-- aborts the migration instead of silently leaving a bypass.
create function wf_private.patch_approval_queue_fragments(
  p_signature regprocedure,
  p_old text,
  p_new text,
  p_expected integer
)
returns void
language plpgsql
set search_path=''
as $$
declare
  definition text;
  occurrences integer;
begin
  if p_old is null or p_old='' or p_expected<1 then
    raise exception 'Invalid guarded function patch.';
  end if;
  select pg_catalog.pg_get_functiondef(p_signature) into definition;
  occurrences := (
    length(definition)-length(replace(definition,p_old,''))
  )/length(p_old);
  if occurrences<>p_expected then
    raise exception 'Expected % occurrences in %, found %',
      p_expected,p_signature,occurrences;
  end if;
  execute replace(definition,p_old,p_new);
end;
$$;

revoke all on function wf_private.patch_approval_queue_fragments(
  regprocedure,text,text,integer
)
from public,anon,authenticated;

select wf_private.patch_approval_queue_fragments(
  'wf_private.query(text,jsonb)'::regprocedure,
  $old$((team and r.employee_id in(select wf_private.scope_ids())) or r.employee_id=a.employee_id or r.workflow_data->>'peer_employee_id'=a.employee_id)$old$,
  $new$((team and r.employee_id in(select wf_private.scope_ids()) and wf_private.approval_role_allowed(r.organization_id,r.request_type)) or r.employee_id=a.employee_id or r.workflow_data->>'peer_employee_id'=a.employee_id)$new$,
  2
);

-- Use the typed/indexed organization key introduced by the commercial tenant
-- boundary migration for audit paging instead of filtering JSON metadata.
select wf_private.patch_approval_queue_fragments(
  'wf_private.query(text,jsonb)'::regprocedure,
  $old$metadata->>'organization_id'=a.organization_id::text$old$,
  $new$organization_id=a.organization_id$new$,
  2
);

drop function wf_private.patch_approval_queue_fragments(
  regprocedure,text,text,integer
);

-- Every future tenant starts with an active, tenant-owned attendance policy.
-- Provisioning still requires an explicit policy choice for each non-kiosk user.
insert into public.attendance_policies(organization_id,name)
select organization.id,'Chuẩn văn phòng'
from public.organizations organization
where not exists(
  select 1 from public.attendance_policies policy
  where policy.organization_id=organization.id
)
on conflict(organization_id,name) do nothing;

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
  from public.config_shifts
  where organization_id=wf_private.default_organization()
  on conflict(organization_id,name) do nothing;

  insert into public.config_system(organization_id,key,value,updated_at)
  select new.id,key,value,clock_timestamp()
  from public.config_system
  where organization_id=wf_private.default_organization()
  on conflict(organization_id,key) do nothing;

  insert into public.workforce_role_capabilities(organization_id,role,capability)
  select new.id,role,capability
  from public.workforce_role_capabilities
  where organization_id=wf_private.default_organization()
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
from public,anon,authenticated;

notify pgrst, 'reload schema';
