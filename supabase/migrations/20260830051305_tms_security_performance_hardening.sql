drop policy if exists employee_reads_own_profile on public.employees;
create policy employee_reads_own_profile
  on public.employees for select to authenticated
  using ((select auth.uid()) = auth_user_id);

drop policy if exists employee_reads_own_attendance on public.attendance;
create policy employee_reads_own_attendance
  on public.attendance for select to authenticated
  using (
    employee_id = (
      select e.employee_id
      from public.employees e
      where e.auth_user_id = (select auth.uid())
    )
  );

create index if not exists attendance_center_id_idx
  on public.attendance (center_id);
create index if not exists attendance_qr_sessions_center_id_idx
  on public.attendance_qr_sessions (center_id);
create index if not exists attendance_qr_sessions_created_by_idx
  on public.attendance_qr_sessions (created_by);

alter default privileges in schema public
  revoke execute on functions from public, anon, authenticated;
