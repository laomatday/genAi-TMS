-- Restore the operational TMS admin surface after the Firebase cutover.
create unique index if not exists employees_email_lower_uidx
  on public.employees (lower(email));

create or replace function public.is_tms_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null and exists (
    select 1
    from public.employees e
    where e.auth_user_id = auth.uid()
      and e.status = 'Active'
      and e.role = 'Admin'
  );
$$;

revoke all on function public.is_tms_admin() from public, anon;
grant execute on function public.is_tms_admin() to authenticated;

drop policy if exists admin_reads_employees on public.employees;
create policy admin_reads_employees
  on public.employees for select to authenticated
  using ((select public.is_tms_admin()));

drop policy if exists admin_inserts_employees on public.employees;
create policy admin_inserts_employees
  on public.employees for insert to authenticated
  with check ((select public.is_tms_admin()));

drop policy if exists admin_updates_employees on public.employees;
create policy admin_updates_employees
  on public.employees for update to authenticated
  using ((select public.is_tms_admin()))
  with check ((select public.is_tms_admin()));

drop policy if exists employee_reads_allowed_locations on public.locations;
create policy employee_reads_allowed_locations
  on public.locations for select to authenticated
  using (
    active and exists (
      select 1
      from public.employees e
      where e.auth_user_id = (select auth.uid())
        and e.status = 'Active'
        and (
          e.role = 'Admin'
          or e.center_id = locations.center_id
          or locations.center_id = any(e.allowed_locations)
        )
    )
  );

drop policy if exists admin_reads_all_locations on public.locations;
create policy admin_reads_all_locations
  on public.locations for select to authenticated
  using ((select public.is_tms_admin()));

drop policy if exists admin_inserts_locations on public.locations;
create policy admin_inserts_locations
  on public.locations for insert to authenticated
  with check ((select public.is_tms_admin()));

drop policy if exists admin_updates_locations on public.locations;
create policy admin_updates_locations
  on public.locations for update to authenticated
  using ((select public.is_tms_admin()))
  with check ((select public.is_tms_admin()));

drop policy if exists authenticated_reads_active_shifts on public.config_shifts;
create policy authenticated_reads_active_shifts
  on public.config_shifts for select to authenticated
  using (active or (select public.is_tms_admin()));

drop policy if exists admin_inserts_shifts on public.config_shifts;
create policy admin_inserts_shifts
  on public.config_shifts for insert to authenticated
  with check ((select public.is_tms_admin()));

drop policy if exists admin_updates_shifts on public.config_shifts;
create policy admin_updates_shifts
  on public.config_shifts for update to authenticated
  using ((select public.is_tms_admin()))
  with check ((select public.is_tms_admin()));

drop policy if exists authenticated_reads_system_config on public.config_system;
create policy authenticated_reads_system_config
  on public.config_system for select to authenticated
  using (true);

drop policy if exists admin_reads_all_attendance on public.attendance;
create policy admin_reads_all_attendance
  on public.attendance for select to authenticated
  using ((select public.is_tms_admin()));

grant select, insert, update on public.employees to authenticated;
grant select, insert, update on public.locations to authenticated;
grant select, insert, update on public.config_shifts to authenticated;
grant select on public.config_system to authenticated;
grant select on public.attendance to authenticated;
grant usage, select on sequence public.config_shifts_id_seq to authenticated;
