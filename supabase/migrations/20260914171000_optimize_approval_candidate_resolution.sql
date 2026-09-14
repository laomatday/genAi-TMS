-- Candidate routing must scale with the small management population rather
-- than invoke the eligibility policy for every employee in a tenant.
set local lock_timeout='5s';
set local statement_timeout='120s';

create index if not exists employees_active_approval_candidates_idx
on public.employees(organization_id,role,employee_id)
where status='Active' and role in ('Leader','Manager','Director','HR','Admin');

do $patch$
declare definition text; old_fragment text; new_fragment text;
begin
  definition:=pg_catalog.pg_get_functiondef('wf_private.submit_request(jsonb)'::regprocedure);
  old_fragment:=$old$ where e.organization_id=a.organization_id
   and e.employee_id is distinct from owner_id
   and wf_private.employee_approval_eligible(a.organization_id,e.employee_id,kind,a.employee_id)$old$;
  new_fragment:=$new$ where e.organization_id=a.organization_id
   and e.status='Active'
   and e.role in ('Leader','Manager','Director','HR','Admin')
   and e.employee_id is distinct from owner_id
   and wf_private.employee_approval_eligible(a.organization_id,e.employee_id,kind,a.employee_id)$new$;
  if (length(definition)-length(replace(definition,old_fragment,'')))/length(old_fragment)<>1 then
    raise exception 'Could not safely optimize request assignee candidates';
  end if;
  execute replace(definition,old_fragment,new_fragment);
end;
$patch$;

do $patch$
declare definition text; old_fragment text; new_fragment text;
begin
  definition:=pg_catalog.pg_get_functiondef('wf_private.maintain(uuid)'::regprocedure);
  old_fragment:=$old$   where x.organization_id=req.organization_id
     and wf_private.employee_approval_eligible(req.organization_id,x.employee_id,req.request_type,req.employee_id)$old$;
  new_fragment:=$new$   where x.organization_id=req.organization_id
     and x.status='Active'
     and x.role in ('Leader','Manager','Director','HR','Admin')
     and wf_private.employee_approval_eligible(req.organization_id,x.employee_id,req.request_type,req.employee_id)$new$;
  if (length(definition)-length(replace(definition,old_fragment,'')))/length(old_fragment)<>1 then
    raise exception 'Could not safely optimize escalation candidates';
  end if;
  execute replace(definition,old_fragment,new_fragment);
end;
$patch$;
