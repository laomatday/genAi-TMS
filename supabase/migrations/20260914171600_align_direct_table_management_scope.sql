-- Match direct-table RLS scope to wf_private.in_scope: team.read grants the
-- feature, while team.read_all/direct-report/managed-location grants the row.
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
    select employee_id,managed_locations,organization_id
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
        wf_private.employee_capable(a.organization_id,a.employee_id,'team.read_all')
        or t.direct_manager_id=a.employee_id
        or t.center_id=any(coalesce(a.managed_locations,'{}'::text[]))
      )
  );
$$;

revoke all on function tms_private.can_manage_employee(text) from public,anon;
grant execute on function tms_private.can_manage_employee(text) to authenticated;

notify pgrst,'reload schema';
