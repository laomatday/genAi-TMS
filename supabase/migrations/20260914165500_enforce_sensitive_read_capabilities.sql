-- Role/scope decides *which* employee may be managed; team.read decides whether
-- the actor may read team data at all. Audit visibility likewise follows the
-- effective capability, including per-employee deny overrides.
set local lock_timeout='5s';
set local statement_timeout='120s';

create or replace function tms_private.can_manage_employee(p_employee_id text)
returns boolean
language sql
stable
security definer
set search_path=''
as $$
  with actor as (
    select employee_id,role,managed_locations,organization_id
    from public.employees
    where auth_user_id=(select auth.uid()) and status='Active'
    limit 1
  ), target as (
    select employee_id,center_id,direct_manager_id,organization_id
    from public.employees
    where employee_id=p_employee_id
  )
  select exists(
    select 1
    from actor a cross join target t
    where t.organization_id=a.organization_id
      and wf_private.employee_capable(a.organization_id,a.employee_id,'team.read')
      and (
        a.role in ('Admin','HR','Director')
        or (
          a.role in ('Manager','Leader')
          and (
            t.direct_manager_id=a.employee_id
            or t.center_id=any(coalesce(a.managed_locations,'{}'::text[]))
          )
        )
      )
  );
$$;

create or replace function tms_private.can_view_audit()
returns boolean
language sql
stable
security definer
set search_path=''
as $$
  select coalesce((
    select wf_private.employee_capable(
      employee.organization_id,employee.employee_id,'audit.view'
    )
    from public.employees employee
    where employee.auth_user_id=(select auth.uid())
      and employee.status='Active'
    limit 1
  ),false);
$$;

revoke all on function tms_private.can_manage_employee(text),
  tms_private.can_view_audit()
from public,anon;
grant execute on function tms_private.can_manage_employee(text),
  tms_private.can_view_audit()
to authenticated;

drop policy if exists audit_logs_read_tenant on public.audit_logs;
create policy audit_logs_read_tenant
on public.audit_logs for select to authenticated
using (
  organization_id=(select wf_private.current_organization())
  and (select tms_private.can_view_audit())
);

notify pgrst,'reload schema';
