-- Configuration writes must honor the effective settings.manage capability,
-- including an explicit per-employee deny. Role labels alone are not an
-- authorization boundary, and every policy remains tenant-scoped.
set local lock_timeout='5s';
set local statement_timeout='120s';

create or replace function tms_private.can_manage_settings(
  p_organization_id uuid
)
returns boolean
language sql
stable
security definer
set search_path=''
as $$
  select (select auth.uid()) is not null
    and exists(
      select 1
      from public.employees employee
      where employee.auth_user_id=(select auth.uid())
        and employee.status='Active'
        and employee.organization_id=p_organization_id
        and wf_private.employee_capable(
          employee.organization_id,
          employee.employee_id,
          'settings.manage'
        )
    );
$$;

revoke all on function tms_private.can_manage_settings(uuid)
from public,anon;
grant execute on function tms_private.can_manage_settings(uuid)
to authenticated;

drop policy if exists config_shifts_insert_tenant on public.config_shifts;
drop policy if exists config_shifts_update_tenant on public.config_shifts;
create policy config_shifts_insert_settings_capability
on public.config_shifts for insert to authenticated
with check (
  organization_id=(select wf_private.current_organization())
  and (select tms_private.can_manage_settings(organization_id))
);
create policy config_shifts_update_settings_capability
on public.config_shifts for update to authenticated
using (
  organization_id=(select wf_private.current_organization())
  and (select tms_private.can_manage_settings(organization_id))
)
with check (
  organization_id=(select wf_private.current_organization())
  and (select tms_private.can_manage_settings(organization_id))
);

drop policy if exists config_system_insert_tenant on public.config_system;
drop policy if exists config_system_update_tenant on public.config_system;
create policy config_system_insert_settings_capability
on public.config_system for insert to authenticated
with check (
  organization_id=(select wf_private.current_organization())
  and (select tms_private.can_manage_settings(organization_id))
);
create policy config_system_update_settings_capability
on public.config_system for update to authenticated
using (
  organization_id=(select wf_private.current_organization())
  and (select tms_private.can_manage_settings(organization_id))
)
with check (
  organization_id=(select wf_private.current_organization())
  and (select tms_private.can_manage_settings(organization_id))
);

drop policy if exists holidays_insert_tenant on public.holidays;
drop policy if exists holidays_update_tenant on public.holidays;
drop policy if exists holidays_delete_tenant on public.holidays;
create policy holidays_insert_settings_capability
on public.holidays for insert to authenticated
with check (
  organization_id=(select wf_private.current_organization())
  and (select tms_private.can_manage_settings(organization_id))
);
create policy holidays_update_settings_capability
on public.holidays for update to authenticated
using (
  organization_id=(select wf_private.current_organization())
  and (select tms_private.can_manage_settings(organization_id))
)
with check (
  organization_id=(select wf_private.current_organization())
  and (select tms_private.can_manage_settings(organization_id))
);
create policy holidays_delete_settings_capability
on public.holidays for delete to authenticated
using (
  organization_id=(select wf_private.current_organization())
  and (select tms_private.can_manage_settings(organization_id))
);

drop policy if exists locations_insert_admin_scope_v3 on public.locations;
drop policy if exists locations_update_admin_scope_v3 on public.locations;
create policy locations_insert_settings_capability
on public.locations for insert to authenticated
with check (
  organization_id=(select wf_private.current_organization())
  and (select tms_private.can_manage_settings(organization_id))
);
create policy locations_update_settings_capability
on public.locations for update to authenticated
using (
  organization_id=(select wf_private.current_organization())
  and (select tms_private.can_manage_settings(organization_id))
)
with check (
  organization_id=(select wf_private.current_organization())
  and (select tms_private.can_manage_settings(organization_id))
);

drop policy if exists attendance_policies_insert_scope_v3 on public.attendance_policies;
drop policy if exists attendance_policies_update_scope_v3 on public.attendance_policies;
drop policy if exists attendance_policies_delete_scope_v3 on public.attendance_policies;
create policy attendance_policies_insert_settings_capability
on public.attendance_policies for insert to authenticated
with check (
  organization_id=(select wf_private.current_organization())
  and (select tms_private.can_manage_settings(organization_id))
);
create policy attendance_policies_update_settings_capability
on public.attendance_policies for update to authenticated
using (
  organization_id=(select wf_private.current_organization())
  and (select tms_private.can_manage_settings(organization_id))
)
with check (
  organization_id=(select wf_private.current_organization())
  and (select tms_private.can_manage_settings(organization_id))
);
create policy attendance_policies_delete_settings_capability
on public.attendance_policies for delete to authenticated
using (
  organization_id=(select wf_private.current_organization())
  and (select tms_private.can_manage_settings(organization_id))
);

notify pgrst,'reload schema';
