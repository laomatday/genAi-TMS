create or replace function tms_private.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null and exists (
    select 1 from public.employees e
    where e.auth_user_id = auth.uid()
      and e.status = 'Active'
      and e.role = 'Admin'
  );
$$;
revoke all on function tms_private.is_admin() from public, anon;
grant usage on schema tms_private to authenticated;
grant execute on function tms_private.is_admin() to authenticated;

drop policy if exists employee_reads_own_profile on public.employees;
drop policy if exists admin_reads_employees on public.employees;
create policy employee_reads_authorized_profiles on public.employees
for select to authenticated
using ((select auth.uid()) = auth_user_id or (select tms_private.is_admin()));

drop policy if exists admin_inserts_employees on public.employees;
create policy admin_inserts_employees on public.employees
for insert to authenticated with check ((select tms_private.is_admin()));
drop policy if exists admin_updates_employees on public.employees;
create policy admin_updates_employees on public.employees
for update to authenticated
using ((select tms_private.is_admin())) with check ((select tms_private.is_admin()));

drop policy if exists employee_reads_own_attendance on public.attendance;
drop policy if exists admin_reads_all_attendance on public.attendance;
create policy employee_reads_authorized_attendance on public.attendance
for select to authenticated
using (
  employee_id = (
    select e.employee_id from public.employees e
    where e.auth_user_id = (select auth.uid())
  )
  or (select tms_private.is_admin())
);

drop policy if exists employee_reads_allowed_locations on public.locations;
drop policy if exists admin_reads_all_locations on public.locations;
create policy employee_reads_authorized_locations on public.locations
for select to authenticated
using (
  (select tms_private.is_admin())
  or (
    active and exists (
      select 1 from public.employees e
      where e.auth_user_id = (select auth.uid())
        and e.status = 'Active'
        and (
          e.center_id = locations.center_id
          or locations.center_id = any(e.allowed_locations)
        )
    )
  )
);

drop policy if exists admin_inserts_locations on public.locations;
create policy admin_inserts_locations on public.locations
for insert to authenticated with check ((select tms_private.is_admin()));
drop policy if exists admin_updates_locations on public.locations;
create policy admin_updates_locations on public.locations
for update to authenticated
using ((select tms_private.is_admin())) with check ((select tms_private.is_admin()));

drop policy if exists authenticated_reads_active_shifts on public.config_shifts;
create policy authenticated_reads_active_shifts on public.config_shifts
for select to authenticated using (active or (select tms_private.is_admin()));
drop policy if exists admin_inserts_shifts on public.config_shifts;
create policy admin_inserts_shifts on public.config_shifts
for insert to authenticated with check ((select tms_private.is_admin()));
drop policy if exists admin_updates_shifts on public.config_shifts;
create policy admin_updates_shifts on public.config_shifts
for update to authenticated
using ((select tms_private.is_admin())) with check ((select tms_private.is_admin()));

drop function if exists public.is_tms_admin();
