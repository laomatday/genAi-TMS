-- The dashboard directory endpoint returns at most one 100-row page. Enriching
-- that page with every employee made aggregate serialization grow roughly N²
-- across N connected users. Keep the context aligned with the same bounded,
-- active directory page and require the directory capability.
set local lock_timeout='5s';
set local statement_timeout='120s';

create or replace function public.tms_directory_context_v1()
returns jsonb
language sql
stable
security definer
set search_path=''
as $$
  select jsonb_build_object(
    'locations',(
      select coalesce(jsonb_agg(
        jsonb_build_object(
          'center_id',location.center_id,
          'center_name',location.center_name,
          'city',location.city,
          'active',location.active
        ) order by location.center_name
      ),'[]'::jsonb)
      from public.locations location
      where location.organization_id=me.organization_id
    ),
    'people',(
      select coalesce(jsonb_agg(
        jsonb_build_object(
          'employee_id',directory_page.employee_id,
          'role',directory_page.role,
          'direct_manager_id',directory_page.direct_manager_id
        ) order by directory_page.name,directory_page.employee_id
      ),'[]'::jsonb)
      from (
        select employee.employee_id,employee.name,employee.role,employee.direct_manager_id
        from public.employees employee
        where employee.organization_id=me.organization_id
          and employee.status='Active'
          and employee.role<>'Kiosk'
        order by employee.name,employee.employee_id
        limit 100
      ) directory_page
    )
  )
  from public.employees me
  where me.auth_user_id=(select auth.uid())
    and me.status='Active'
    and wf_private.capable('directory.read')
  limit 1;
$$;

revoke all on function public.tms_directory_context_v1()
from public,anon;
grant execute on function public.tms_directory_context_v1()
to authenticated;

notify pgrst,'reload schema';
