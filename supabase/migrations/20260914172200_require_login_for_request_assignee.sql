-- An active profile without an Auth identity cannot open or decide a request,
-- so it must never be selected as owner or fallback.
set local lock_timeout='5s';
set local statement_timeout='120s';

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
    or candidate.auth_user_id is null
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

revoke all on function wf_private.employee_approval_eligible(uuid,text,text,text)
from public,anon,authenticated,service_role;
