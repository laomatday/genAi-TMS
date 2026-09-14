-- Use one policy engine for queue visibility, mutation authorization and the
-- initial/fallback assignee. This avoids notifying an approver who cannot open
-- the request, and prevents team.read overrides from leaking reviewer rows.
set local lock_timeout='5s';
set local statement_timeout='120s';

create or replace function wf_private.employee_capable(
  p_organization_id uuid,
  p_employee_id text,
  p_capability text
)
returns boolean
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  employee_role text;
  answer boolean;
begin
  select employee.role into employee_role
  from public.employees employee
  where employee.organization_id=p_organization_id
    and employee.employee_id=p_employee_id
    and employee.status='Active';
  if employee_role is null then return false; end if;

  select capability.enabled into answer
  from public.workforce_employee_capabilities capability
  where capability.organization_id=p_organization_id
    and capability.employee_id=p_employee_id
    and capability.capability=p_capability;
  if found then return answer; end if;

  return exists(
    select 1
    from public.workforce_role_capabilities capability
    where capability.organization_id=p_organization_id
      and capability.role=employee_role
      and capability.capability=p_capability
      and capability.enabled
  );
end;
$$;

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
declare
  raw_config text;
  config jsonb;
  family text;
begin
  if p_role='Admin' then return true; end if;
  family := case
    when p_request_type in ('EXPLANATION','CORRECTION') then 'attendance'
    else 'leave'
  end;

  select setting.value into raw_config
  from public.config_system setting
  where setting.organization_id=p_organization_id
    and setting.key='APPROVAL_ROLES';
  if not found then return p_role in ('Manager','Director','HR'); end if;
  if raw_config is null then return false; end if;

  begin
    config:=raw_config::jsonb;
  exception when others then
    return false;
  end;
  if jsonb_typeof(config)<>'object'
    or jsonb_typeof(config->'leave') is distinct from 'array'
    or jsonb_typeof(config->'attendance') is distinct from 'array' then
    return false;
  end if;
  return exists(
    select 1 from jsonb_array_elements_text(config->family) configured(role)
    where configured.role=p_role
  );
end;
$$;

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
  actor_employee_id text;
  actor_organization uuid;
begin
  select employee.role,employee.employee_id,employee.organization_id
  into actor_role,actor_employee_id,actor_organization
  from public.employees employee
  where employee.auth_user_id=(select auth.uid())
    and employee.status='Active'
  limit 1;

  return actor_role is not null
    and actor_organization=p_organization_id
    and wf_private.employee_capable(actor_organization,actor_employee_id,'team.read')
    and wf_private.employee_capable(actor_organization,actor_employee_id,'attendance.review')
    and wf_private.approval_role_configured(actor_organization,actor_role,p_request_type);
end;
$$;

create or replace function wf_private.employee_approval_eligible(
  p_organization_id uuid,
  p_candidate_id text,
  p_request_type text,
  p_subject_id text
)
returns boolean
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  candidate public.employees%rowtype;
  subject public.employees%rowtype;
begin
  select * into candidate from public.employees
  where organization_id=p_organization_id
    and employee_id=p_candidate_id
    and status='Active';
  select * into subject from public.employees
  where organization_id=p_organization_id
    and employee_id=p_subject_id
    and status='Active';
  if candidate.employee_id is null
    or subject.employee_id is null
    or candidate.employee_id=subject.employee_id then
    return false;
  end if;
  return wf_private.employee_capable(p_organization_id,candidate.employee_id,'team.read')
    and wf_private.employee_capable(p_organization_id,candidate.employee_id,'attendance.review')
    and wf_private.approval_role_configured(p_organization_id,candidate.role,p_request_type)
    and (
      wf_private.employee_capable(p_organization_id,candidate.employee_id,'team.read_all')
      or subject.direct_manager_id=candidate.employee_id
      or subject.center_id=any(coalesce(candidate.managed_locations,'{}'::text[]))
    );
end;
$$;

revoke all on function wf_private.employee_capable(uuid,text,text),
  wf_private.approval_role_configured(uuid,text,text),
  wf_private.employee_approval_eligible(uuid,text,text,text)
from public,anon,authenticated,service_role;
grant execute on function wf_private.approval_role_allowed(uuid,text)
to authenticated;

do $patch$
declare
  definition text;
  old_fragment text:=$old$ select e.employee_id into owner_id from public.employees e where e.employee_id=a.direct_manager_id and e.status='Active' and e.organization_id=a.organization_id and e.employee_id<>a.employee_id and e.role in ('Leader','Manager','Director','HR','Admin');
 select e.employee_id into backup_id from public.employees e where e.organization_id=a.organization_id and e.status='Active' and e.employee_id<>a.employee_id and e.role in ('HR','Admin') and e.employee_id is distinct from owner_id order by case when e.role='HR' then 0 else 1 end,e.employee_id limit 1;
 owner_id:=coalesce(owner_id,backup_id);$old$;
  new_fragment text:=$new$ select e.employee_id into owner_id
 from public.employees e
 where e.employee_id=a.direct_manager_id
   and wf_private.employee_approval_eligible(a.organization_id,e.employee_id,kind,a.employee_id)
 limit 1;
 select e.employee_id into backup_id
 from public.employees e
 where e.organization_id=a.organization_id
   and e.employee_id is distinct from owner_id
   and wf_private.employee_approval_eligible(a.organization_id,e.employee_id,kind,a.employee_id)
 order by
   case when wf_private.employee_capable(a.organization_id,e.employee_id,'team.read_all') then 0 else 1 end,
   case e.role when 'HR' then 0 when 'Admin' then 1 when 'Director' then 2 when 'Manager' then 3 else 4 end,
   e.employee_id
 limit 1;
 if owner_id is null then owner_id:=backup_id; backup_id:=null; end if;
 if owner_id is null then raise exception 'Chưa có người duyệt phù hợp với chính sách của tổ chức.' using errcode='55000'; end if;$new$;
begin
  definition:=pg_catalog.pg_get_functiondef('wf_private.submit_request(jsonb)'::regprocedure);
  if (length(definition)-length(replace(definition,old_fragment,'')))/length(old_fragment)<>1 then
    raise exception 'Could not safely patch request assignee selection';
  end if;
  execute replace(definition,old_fragment,new_fragment);
end;
$patch$;

do $patch$
declare
  definition text;
  old_fragment text:=$old$  if req.fallback_to is not null and req.fallback_to<>req.employee_id and exists(select 1 from public.employees x where x.employee_id=req.fallback_to and x.status='Active' and x.organization_id=req.organization_id) then
   update public.attendance_requests set assigned_to=fallback_to,escalated_at=now_at where id=req.id;
   perform wf_private.notify(req.fallback_to,'overdue:'||req.id::text,'REQUEST_OVERDUE','Yêu cầu đã quá hạn xử lý','Bạn được chỉ định xử lý thay.',jsonb_build_object('request_id',req.id));
  else
   perform wf_private.notify(req.assigned_to,'overdue:'||req.id::text,'REQUEST_OVERDUE','Yêu cầu đang quá hạn','Vui lòng xử lý yêu cầu trong hàng chờ.',jsonb_build_object('request_id',req.id));
  end if;$old$;
  new_fragment text:=$new$  if req.fallback_to is not null and wf_private.employee_approval_eligible(req.organization_id,req.fallback_to,req.request_type,req.employee_id) then
   update public.attendance_requests set assigned_to=fallback_to,escalated_at=now_at where id=req.id;
   perform wf_private.notify(req.fallback_to,'overdue:'||req.id::text,'REQUEST_OVERDUE','Yêu cầu đã quá hạn xử lý','Bạn được chỉ định xử lý thay.',jsonb_build_object('request_id',req.id));
  elsif req.assigned_to is not null and wf_private.employee_approval_eligible(req.organization_id,req.assigned_to,req.request_type,req.employee_id) then
   update public.attendance_requests set escalated_at=now_at where id=req.id;
   perform wf_private.notify(req.assigned_to,'overdue:'||req.id::text,'REQUEST_OVERDUE','Yêu cầu đang quá hạn','Vui lòng xử lý yêu cầu trong hàng chờ.',jsonb_build_object('request_id',req.id));
  else
   select x.employee_id into req.assigned_to
   from public.employees x
   where x.organization_id=req.organization_id
     and wf_private.employee_approval_eligible(req.organization_id,x.employee_id,req.request_type,req.employee_id)
   order by case when wf_private.employee_capable(req.organization_id,x.employee_id,'team.read_all') then 0 else 1 end,x.employee_id
   limit 1;
   if req.assigned_to is not null then
    update public.attendance_requests set assigned_to=req.assigned_to,fallback_to=null,escalated_at=now_at where id=req.id;
    perform wf_private.notify(req.assigned_to,'overdue:'||req.id::text,'REQUEST_OVERDUE','Yêu cầu đã được chuyển người xử lý','Vui lòng xử lý yêu cầu trong hàng chờ.',jsonb_build_object('request_id',req.id));
   end if;
  end if;$new$;
begin
  definition:=pg_catalog.pg_get_functiondef('wf_private.maintain(uuid)'::regprocedure);
  if (length(definition)-length(replace(definition,old_fragment,'')))/length(old_fragment)<>1 then
    raise exception 'Could not safely patch request escalation routing';
  end if;
  execute replace(definition,old_fragment,new_fragment);
end;
$patch$;

notify pgrst,'reload schema';
