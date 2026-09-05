create index if not exists employees_attendance_policy_idx on public.employees(attendance_policy_id);
create index if not exists attendance_events_timesheet_idx on public.attendance_events(timesheet_id);
create index if not exists attendance_requests_timesheet_idx on public.attendance_requests(timesheet_id);
create index if not exists attendance_requests_employee_idx on public.attendance_requests(employee_id, created_at desc);
create index if not exists timesheets_policy_idx on public.timesheets(policy_id);
create index if not exists timesheets_checkin_event_idx on public.timesheets(checkin_event_id) where checkin_event_id is not null;
create index if not exists timesheets_checkout_event_idx on public.timesheets(checkout_event_id) where checkout_event_id is not null;

drop policy if exists "tms_v2_policy_read" on public.attendance_policies;
drop policy if exists "tms_v2_policy_admin_write" on public.attendance_policies;
create policy "tms_v2_policy_read" on public.attendance_policies for select to authenticated
using (active or exists(select 1 from public.employees e where e.auth_user_id=(select auth.uid()) and e.role in ('Admin','HR','Director') and e.status='Active'));
create policy "tms_v2_policy_insert" on public.attendance_policies for insert to authenticated
with check (exists(select 1 from public.employees e where e.auth_user_id=(select auth.uid()) and e.role='Admin' and e.status='Active'));
create policy "tms_v2_policy_update" on public.attendance_policies for update to authenticated
using (exists(select 1 from public.employees e where e.auth_user_id=(select auth.uid()) and e.role='Admin' and e.status='Active'))
with check (exists(select 1 from public.employees e where e.auth_user_id=(select auth.uid()) and e.role='Admin' and e.status='Active'));
create policy "tms_v2_policy_delete" on public.attendance_policies for delete to authenticated
using (exists(select 1 from public.employees e where e.auth_user_id=(select auth.uid()) and e.role='Admin' and e.status='Active'));

drop policy if exists "tms_v2_qr_read" on public.qr_stations;
drop policy if exists "tms_v2_qr_admin_write" on public.qr_stations;
create policy "tms_v2_qr_read" on public.qr_stations for select to authenticated using (true);
create policy "tms_v2_qr_insert" on public.qr_stations for insert to authenticated
with check (exists(select 1 from public.employees e where e.auth_user_id=(select auth.uid()) and e.role in ('Admin','HR','Director','Kiosk') and e.status='Active'));
create policy "tms_v2_qr_update" on public.qr_stations for update to authenticated
using (exists(select 1 from public.employees e where e.auth_user_id=(select auth.uid()) and e.role in ('Admin','HR','Director','Kiosk') and e.status='Active'))
with check (exists(select 1 from public.employees e where e.auth_user_id=(select auth.uid()) and e.role in ('Admin','HR','Director','Kiosk') and e.status='Active'));
create policy "tms_v2_qr_delete" on public.qr_stations for delete to authenticated
using (exists(select 1 from public.employees e where e.auth_user_id=(select auth.uid()) and e.role='Admin' and e.status='Active'));

drop policy if exists "tms_v2_audit_admin_read" on public.audit_logs;
create policy "tms_v2_audit_admin_read" on public.audit_logs for select to authenticated
using (exists(select 1 from public.employees e where e.auth_user_id=(select auth.uid()) and e.role in ('Admin','HR','Director') and e.status='Active'));
