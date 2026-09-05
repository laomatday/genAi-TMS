-- Desktop Admin Control Center: scoped reads, audited configuration and dynamic QR timing.
-- Production migration version: 20260904003827.

insert into public.config_system(key, value)
values
  ('MIN_HOURS_FULL', '7'),
  ('MIN_HOURS_HALF', '3.5'),
  ('OFF_DAYS', '0'),
  ('LOCK_DATE', '5'),
  ('QR_REFRESH_SECONDS', '30'),
  ('QR_VALIDITY_SECONDS', '45')
on conflict (key) do nothing;

create index if not exists timesheets_work_date_id_idx
  on public.timesheets(work_date desc, id);

create index if not exists attendance_requests_status_id_idx
  on public.attendance_requests(status, id);

create index if not exists attendance_explanations_status_created_id_idx
  on public.attendance_explanations(status, created_at desc, id);

create or replace function tms_private.is_admin_operator()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null and exists (
    select 1
    from public.employees e
    where e.auth_user_id = (select auth.uid())
      and e.status = 'Active'
      and e.role in ('Admin', 'HR', 'Director')
  );
$$;

revoke all on function tms_private.is_admin_operator() from public, anon;
grant execute on function tms_private.is_admin_operator() to authenticated;

drop policy if exists tms_admin_employee_scope on public.employees;
create policy tms_admin_employee_scope
  on public.employees for select to authenticated
  using (
    employee_id = (select tms_private.current_employee_id())
    or (select tms_private.can_manage_employee(employee_id))
  );

drop policy if exists tms_admin_location_read on public.locations;
create policy tms_admin_location_read
  on public.locations for select to authenticated
  using ((select tms_private.is_admin_operator()));

drop policy if exists "tms_v2_qr_read" on public.qr_stations;
create policy "tms_v2_qr_read"
  on public.qr_stations for select to authenticated
  using (
    station_user_id = (select auth.uid())
    or (select tms_private.is_admin_operator())
  );

drop policy if exists "tms_v2_qr_insert" on public.qr_stations;
drop policy if exists "tms_v2_qr_update" on public.qr_stations;
drop policy if exists "tms_v2_qr_delete" on public.qr_stations;

-- Public tables remain Data API-readable only where the app needs them.
revoke all on table public.employees from anon, authenticated;
grant select on table public.employees to authenticated;

revoke all on table public.attendance_policies, public.qr_stations,
  public.trusted_devices, public.timesheets, public.attendance_requests,
  public.audit_logs from anon, authenticated;
grant select on table public.attendance_policies, public.qr_stations,
  public.trusted_devices, public.timesheets, public.attendance_requests,
  public.audit_logs to authenticated;
grant insert, update on table public.attendance_policies to authenticated;

revoke delete on table public.locations, public.config_shifts,
  public.config_system, public.holidays from authenticated;

create or replace function tms_private.audit_admin_config_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id text;
  row_after jsonb;
  row_before jsonb;
  record_id text;
begin
  actor_id := tms_private.current_employee_id();
  if actor_id is null then
    return new;
  end if;

  row_after := to_jsonb(new);
  row_before := case when tg_op = 'UPDATE' then to_jsonb(old) else null end;
  record_id := coalesce(
    row_after ->> 'id',
    row_after ->> 'center_id',
    row_after ->> 'key',
    row_after ->> 'name'
  );

  insert into public.audit_logs(
    actor_employee_id,
    action,
    entity_type,
    entity_id,
    reason,
    metadata
  ) values (
    actor_id,
    'ADMIN_CONFIG_' || tg_op,
    tg_table_name,
    record_id,
    case when tg_op = 'INSERT' then 'Tạo cấu hình' else 'Cập nhật cấu hình' end,
    jsonb_build_object('before', row_before, 'after', row_after)
  );
  return new;
end;
$$;

revoke all on function tms_private.audit_admin_config_change() from public, anon, authenticated;

drop trigger if exists attendance_policies_admin_audit on public.attendance_policies;
create trigger attendance_policies_admin_audit
after insert or update on public.attendance_policies
for each row execute function tms_private.audit_admin_config_change();

drop trigger if exists config_shifts_admin_audit on public.config_shifts;
create trigger config_shifts_admin_audit
after insert or update on public.config_shifts
for each row execute function tms_private.audit_admin_config_change();

drop trigger if exists config_system_admin_audit on public.config_system;
create trigger config_system_admin_audit
after insert or update on public.config_system
for each row execute function tms_private.audit_admin_config_change();

drop trigger if exists holidays_admin_audit on public.holidays;
create trigger holidays_admin_audit
after insert or update on public.holidays
for each row execute function tms_private.audit_admin_config_change();

drop trigger if exists locations_admin_audit on public.locations;
create trigger locations_admin_audit
after insert or update on public.locations
for each row execute function tms_private.audit_admin_config_change();

create or replace function public.update_qr_station_admin(
  p_id uuid,
  p_name text,
  p_center_id text,
  p_active boolean
)
returns public.qr_stations
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor public.employees%rowtype;
  station public.qr_stations%rowtype;
begin
  select * into actor
  from public.employees
  where auth_user_id = (select auth.uid())
    and status = 'Active';
  if not found or actor.role <> 'Admin' then
    raise exception 'Chỉ Admin được cấu hình trạm Kiosk.';
  end if;
  if length(trim(coalesce(p_name, ''))) < 2 then
    raise exception 'Tên trạm phải có ít nhất 2 ký tự.';
  end if;
  if not exists (
    select 1 from public.locations l
    where l.center_id = p_center_id and l.active
  ) then
    raise exception 'Địa điểm không tồn tại hoặc đã tắt.';
  end if;

  update public.qr_stations
  set name = trim(p_name),
      center_id = p_center_id,
      active = p_active,
      updated_at = clock_timestamp()
  where id = p_id
  returning * into station;
  if not found then
    raise exception 'Không tìm thấy trạm Kiosk.';
  end if;

  insert into public.audit_logs(
    actor_employee_id, action, entity_type, entity_id, reason, metadata
  ) values (
    actor.employee_id,
    'QR_STATION_UPDATED',
    'qr_station',
    station.id::text,
    case when station.active then 'Cập nhật trạm Kiosk' else 'Vô hiệu hóa trạm Kiosk' end,
    jsonb_build_object('name', station.name, 'center_id', station.center_id, 'active', station.active)
  );
  return station;
end;
$$;

revoke all on function public.update_qr_station_admin(uuid, text, text, boolean) from public, anon;
grant execute on function public.update_qr_station_admin(uuid, text, text, boolean) to authenticated;

create or replace function public.create_attendance_qr(p_center_id text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  operator_row public.employees%rowtype;
  location_row public.locations%rowtype;
  requested_center text;
  raw_token text;
  expiry timestamptz;
  expiry_ms bigint;
  validity_seconds integer := 45;
  station_enabled boolean;
begin
  if (select auth.uid()) is null then
    raise exception 'Vui lòng đăng nhập.';
  end if;
  select * into operator_row
  from public.employees
  where auth_user_id = (select auth.uid()) and status = 'Active';
  if not found then
    raise exception 'Không tìm thấy hồ sơ nhân viên.';
  end if;
  if operator_row.role not in ('Admin', 'Director', 'HR', 'Kiosk') then
    raise exception 'Tài khoản không có quyền mở trạm QR.';
  end if;

  requested_center := coalesce(nullif(trim(p_center_id), ''), operator_row.center_id);
  if operator_row.role <> 'Admin'
    and requested_center <> operator_row.center_id
    and not (requested_center = any(coalesce(operator_row.allowed_locations, '{}'::text[]))) then
    raise exception 'Bạn chỉ được mở trạm QR tại chi nhánh đã gán.';
  end if;
  select * into location_row
  from public.locations
  where center_id = requested_center and active;
  if not found then
    raise exception 'Chi nhánh chưa cấu hình vị trí.';
  end if;

  select qs.active into station_enabled
  from public.qr_stations qs
  where qs.station_user_id = (select auth.uid());
  if found and not station_enabled then
    raise exception 'Trạm Kiosk đã bị Admin vô hiệu hóa.';
  end if;

  insert into public.qr_stations(
    station_user_id, center_id, name, active, created_by, updated_at
  ) values (
    (select auth.uid()), requested_center, 'Trạm QR - ' || location_row.center_name,
    true, operator_row.employee_id, clock_timestamp()
  )
  on conflict(station_user_id) do update
  set center_id = excluded.center_id,
      created_by = excluded.created_by,
      updated_at = excluded.updated_at;

  select least(300, greatest(15, value::integer))
  into validity_seconds
  from public.config_system
  where key = 'QR_VALIDITY_SECONDS'
    and value ~ '^[0-9]+$';
  validity_seconds := coalesce(validity_seconds, 45);

  raw_token := translate(encode(extensions.gen_random_bytes(24), 'base64'), E'+/\\\n', '-_');
  expiry := clock_timestamp() + make_interval(secs => validity_seconds);
  expiry_ms := floor(extract(epoch from expiry) * 1000);

  insert into public.attendance_qr_sessions(
    station_user_id, center_id, token_hash, created_by, issued_at, expires_at
  ) values (
    (select auth.uid()), requested_center,
    encode(extensions.digest(raw_token, 'sha256'), 'hex'),
    operator_row.employee_id, clock_timestamp(), expiry
  )
  on conflict(station_user_id) do update
  set center_id = excluded.center_id,
      token_hash = excluded.token_hash,
      created_by = excluded.created_by,
      issued_at = excluded.issued_at,
      expires_at = excluded.expires_at;

  return jsonb_build_object(
    'payload', jsonb_build_object(
      'v', 1,
      's', (select auth.uid()),
      'c', requested_center,
      't', raw_token,
      'e', expiry_ms
    )::text,
    'expiresAt', expiry_ms,
    'branchName', location_row.center_name
  );
end;
$$;

revoke all on function public.create_attendance_qr(text) from public, anon;
grant execute on function public.create_attendance_qr(text) to authenticated;

create or replace function public.submit_attendance_request_v2(
  p_timesheet_id uuid,
  p_request_type text,
  p_reason text,
  p_requested_checkin timestamptz default null,
  p_requested_checkout timestamptz default null
)
returns public.attendance_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  employee_row public.employees%rowtype;
  timesheet_row public.timesheets%rowtype;
  request_row public.attendance_requests%rowtype;
  lock_day integer := 5;
  next_month_start date;
  deadline_date date;
begin
  select * into employee_row
  from public.employees
  where auth_user_id = (select auth.uid()) and status = 'Active';
  if not found then raise exception 'Không tìm thấy nhân viên.'; end if;

  select * into timesheet_row
  from public.timesheets
  where id = p_timesheet_id and employee_id = employee_row.employee_id
  for update;
  if not found then raise exception 'Không tìm thấy ngày công.'; end if;
  if timesheet_row.status = 'LOCKED' then raise exception 'Ngày công đã khóa.'; end if;

  select least(31, greatest(1, value::integer)) into lock_day
  from public.config_system
  where key = 'LOCK_DATE' and value ~ '^[0-9]+$';
  lock_day := coalesce(lock_day, 5);
  next_month_start := (date_trunc('month', timesheet_row.work_date::timestamp) + interval '1 month')::date;
  deadline_date := least(
    next_month_start + (lock_day - 1),
    (next_month_start + interval '1 month' - interval '1 day')::date
  );
  if (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date > deadline_date then
    raise exception 'Đã quá hạn giải trình ngày công này.';
  end if;

  if p_request_type not in ('EXPLANATION', 'CORRECTION') then
    raise exception 'Loại yêu cầu không hợp lệ.';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'Vui lòng nhập lý do.';
  end if;
  if exists (
    select 1 from public.attendance_requests request
    where request.timesheet_id = timesheet_row.id and request.status = 'PENDING'
  ) then
    raise exception 'Ngày này đã có yêu cầu đang chờ duyệt.';
  end if;
  if p_request_type = 'CORRECTION'
    and p_requested_checkin is null
    and p_requested_checkout is null then
    raise exception 'Điều chỉnh công cần có giờ đề nghị.';
  end if;

  insert into public.attendance_requests(
    timesheet_id, employee_id, request_type, exception_code,
    requested_checkin, requested_checkout, reason, status
  ) values (
    timesheet_row.id,
    employee_row.employee_id,
    p_request_type,
    case when coalesce(array_length(timesheet_row.exception_codes, 1), 0) > 0
      then timesheet_row.exception_codes[1] else null end,
    p_requested_checkin,
    p_requested_checkout,
    trim(p_reason),
    'PENDING'
  ) returning * into request_row;

  update public.timesheets
  set status = 'PENDING_REVIEW', updated_at = clock_timestamp()
  where id = timesheet_row.id;

  insert into public.audit_logs(
    actor_employee_id, target_employee_id, action,
    entity_type, entity_id, reason, metadata
  ) values (
    employee_row.employee_id,
    employee_row.employee_id,
    'ATTENDANCE_REQUEST_SUBMITTED',
    'attendance_request',
    request_row.id::text,
    request_row.reason,
    jsonb_build_object('type', p_request_type, 'timesheet_id', timesheet_row.id)
  );
  return request_row;
end;
$$;

revoke all on function public.submit_attendance_request_v2(uuid, text, text, timestamptz, timestamptz) from public, anon;
grant execute on function public.submit_attendance_request_v2(uuid, text, text, timestamptz, timestamptz) to authenticated;

-- Keep the control center accurate while the employee app still writes the legacy
-- attendance table. Existing adjusted/locked rows always win over synchronized data.
create or replace function public.refresh_tms_exceptions_v2(
  p_from date default null,
  p_to date default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor public.employees%rowtype;
  from_date date;
  to_date date;
  inserted_count integer := 0;
begin
  select * into actor
  from public.employees
  where auth_user_id = (select auth.uid()) and status = 'Active';
  if not found or actor.role not in ('Admin', 'HR', 'Director') then
    raise exception 'Forbidden';
  end if;

  from_date := coalesce(p_from, ((clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date - 31));
  to_date := coalesce(p_to, (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date);
  if from_date > to_date then raise exception 'Khoảng ngày không hợp lệ.'; end if;

  insert into public.timesheets as current_timesheet(
    employee_id, work_date, policy_id, location_id,
    expected_start, expected_end, actual_checkin, actual_checkout,
    status, source, exception_codes, late_minutes, early_minutes, work_minutes
  )
  select
    attendance.employee_id,
    attendance.attendance_date,
    employee.attendance_policy_id,
    attendance.center_id,
    case when policy.id is not null
      then ((attendance.attendance_date + policy.expected_start) at time zone 'Asia/Ho_Chi_Minh')
      else null end,
    case when policy.id is not null
      then ((attendance.attendance_date + policy.expected_end) at time zone 'Asia/Ho_Chi_Minh')
      else null end,
    attendance.checked_in_at,
    attendance.checked_out_at,
    case
      when attendance.checked_out_at is null then 'OPEN'
      when attendance.is_valid = 'No' or attendance.status = 'Invalid'
        or attendance.late_minutes > 0 or attendance.early_minutes > 0 then 'EXCEPTION'
      when coalesce(policy.auto_approve, true) then 'AUTO_APPROVED'
      else 'COMPLETE'
    end,
    'LEGACY',
    array_remove(array[
      case when attendance.checked_out_at is null then 'MISSING_CHECKOUT' end,
      case when attendance.late_minutes > 0 then 'LATE' end,
      case when attendance.early_minutes > 0 then 'EARLY_LEAVE' end,
      case when attendance.is_valid = 'No' or attendance.status = 'Invalid' then 'INVALID_LEGACY' end
    ]::text[], null),
    greatest(0, attendance.late_minutes),
    greatest(0, attendance.early_minutes),
    greatest(0, round(coalesce(attendance.work_hours, 0) * 60)::integer)
  from public.attendance attendance
  join public.employees employee on employee.employee_id = attendance.employee_id
  left join public.attendance_policies policy on policy.id = employee.attendance_policy_id
  where attendance.attendance_date between from_date and to_date
  on conflict(employee_id, work_date) do update
  set policy_id = excluded.policy_id,
      location_id = excluded.location_id,
      expected_start = excluded.expected_start,
      expected_end = excluded.expected_end,
      actual_checkin = excluded.actual_checkin,
      actual_checkout = excluded.actual_checkout,
      status = case
        when current_timesheet.status = 'APPROVED' then current_timesheet.status
        else excluded.status
      end,
      source = excluded.source,
      exception_codes = case
        when current_timesheet.status = 'APPROVED' then current_timesheet.exception_codes
        else excluded.exception_codes
      end,
      late_minutes = excluded.late_minutes,
      early_minutes = excluded.early_minutes,
      work_minutes = excluded.work_minutes,
      updated_at = clock_timestamp()
  where current_timesheet.source <> 'ADJUSTED'
    and current_timesheet.status <> 'LOCKED';

  update public.timesheets
  set status = 'EXCEPTION',
      exception_codes = array_append(
        array_remove(coalesce(exception_codes, '{}'::text[]), 'MISSING_CHECKOUT'),
        'MISSING_CHECKOUT'
      ),
      updated_at = clock_timestamp()
  where work_date between from_date and to_date
    and work_date <= (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date
    and actual_checkin is not null
    and actual_checkout is null
    and status in ('OPEN', 'COMPLETE')
    and (
      work_date < (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date
      or (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::time > '23:00'::time
    );

  insert into public.timesheets as generated_timesheet(
    employee_id, work_date, policy_id, location_id,
    expected_start, expected_end, status, exception_codes
  )
  select
    employee.employee_id,
    generated_day::date,
    policy.id,
    employee.center_id,
    ((generated_day::date + policy.expected_start) at time zone 'Asia/Ho_Chi_Minh'),
    ((generated_day::date + policy.expected_end) at time zone 'Asia/Ho_Chi_Minh'),
    case
      when exists (
        select 1 from public.holidays holiday
        where holiday.active
          and generated_day::date between holiday.from_date and holiday.to_date
      ) then 'APPROVED'
      when exists (
        select 1 from public.leave_requests leave_request
        where leave_request.employee_id = employee.employee_id
          and leave_request.status = 'Approved'
          and generated_day::date between leave_request.from_date and leave_request.to_date
      ) then 'APPROVED'
      else 'EXCEPTION'
    end,
    case
      when exists (
        select 1 from public.holidays holiday
        where holiday.active
          and generated_day::date between holiday.from_date and holiday.to_date
      ) then array['HOLIDAY']
      when exists (
        select 1 from public.leave_requests leave_request
        where leave_request.employee_id = employee.employee_id
          and leave_request.status = 'Approved'
          and generated_day::date between leave_request.from_date and leave_request.to_date
      ) then array['APPROVED_LEAVE']
      else array['MISSING_CHECKIN']
    end
  from public.employees employee
  join public.attendance_policies policy
    on policy.id = employee.attendance_policy_id and policy.active
  cross join lateral generate_series(
    greatest(from_date, (employee.created_at at time zone 'Asia/Ho_Chi_Minh')::date),
    to_date,
    interval '1 day'
  ) generated_day
  where employee.status = 'Active'
    and employee.role <> 'Kiosk'
    and extract(isodow from generated_day)::smallint = any(policy.work_days)
    and (
      generated_day::date < (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date
      or (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::time > policy.checkin_window_end
    )
  on conflict(employee_id, work_date) do update
  set policy_id = excluded.policy_id,
      location_id = excluded.location_id,
      expected_start = excluded.expected_start,
      expected_end = excluded.expected_end,
      status = excluded.status,
      exception_codes = excluded.exception_codes,
      updated_at = clock_timestamp()
  where generated_timesheet.actual_checkin is null
    and generated_timesheet.source <> 'ADJUSTED'
    and generated_timesheet.status not in ('LOCKED', 'APPROVED', 'PENDING_REVIEW');
  get diagnostics inserted_count = row_count;
  return inserted_count;
end;
$$;

revoke all on function public.refresh_tms_exceptions_v2(date, date) from public, anon;
grant execute on function public.refresh_tms_exceptions_v2(date, date) to authenticated;

create or replace function public.submit_attendance_explanation(
  p_attendance_date date,
  p_reason text
)
returns public.attendance_explanations
language plpgsql
security definer
set search_path = ''
as $$
declare
  employee_row public.employees%rowtype;
  result_row public.attendance_explanations%rowtype;
  local_today date := (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date;
  current_month date;
  target_month date;
  lock_day integer := 5;
  existing_count integer;
begin
  if (select auth.uid()) is null then raise exception 'Vui lòng đăng nhập.'; end if;
  select * into employee_row
  from public.employees
  where auth_user_id = (select auth.uid()) and status = 'Active';
  if not found then raise exception 'Không tìm thấy hồ sơ nhân viên.'; end if;
  if p_attendance_date is null or p_attendance_date > local_today then
    raise exception 'Ngày giải trình không hợp lệ.';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 2 then
    raise exception 'Vui lòng nhập nội dung giải trình.';
  end if;

  select least(31, greatest(1, value::integer)) into lock_day
  from public.config_system
  where key = 'LOCK_DATE' and value ~ '^[0-9]+$';
  lock_day := coalesce(lock_day, 5);
  current_month := date_trunc('month', local_today)::date;
  target_month := date_trunc('month', p_attendance_date)::date;
  if not (
    target_month = current_month
    or (
      target_month = (current_month - interval '1 month')::date
      and extract(day from local_today) <= lock_day
    )
  ) then
    raise exception 'Đã quá thời hạn giải trình ngày công.';
  end if;

  select count(*) into existing_count
  from public.attendance_explanations explanation
  where explanation.employee_id = employee_row.employee_id
    and date_trunc('month', explanation.attendance_date)::date = target_month
    and explanation.status <> 'Rejected';
  if existing_count >= 5 then
    raise exception 'Bạn đã đạt giới hạn 5 giải trình trong tháng này.';
  end if;

  insert into public.attendance_explanations(
    employee_id, attendance_date, reason, status
  ) values (
    employee_row.employee_id, p_attendance_date, trim(p_reason), 'Pending'
  ) returning * into result_row;

  insert into public.audit_logs(
    actor_employee_id, target_employee_id, action,
    entity_type, entity_id, reason, metadata
  ) values (
    employee_row.employee_id,
    employee_row.employee_id,
    'ATTENDANCE_REQUEST_SUBMITTED',
    'attendance_explanation',
    result_row.id::text,
    result_row.reason,
    jsonb_build_object('attendance_date', p_attendance_date, 'origin', 'legacy')
  );
  return result_row;
end;
$$;

revoke all on function public.submit_attendance_explanation(date, text) from public, anon;
grant execute on function public.submit_attendance_explanation(date, text) to authenticated;

create or replace function public.review_attendance_explanation(
  p_id uuid,
  p_status text,
  p_note text default ''
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  explanation_row public.attendance_explanations%rowtype;
  actor_id text;
begin
  if p_status not in ('Approved', 'Rejected') then raise exception 'Trạng thái không hợp lệ.'; end if;
  select * into explanation_row
  from public.attendance_explanations
  where id = p_id
  for update;
  if not found then raise exception 'Không tìm thấy giải trình.'; end if;
  if explanation_row.status <> 'Pending' then raise exception 'Giải trình đã được xử lý.'; end if;
  if not tms_private.can_manage_employee(explanation_row.employee_id) then raise exception 'Forbidden'; end if;
  select tms_private.current_employee_id() into actor_id;
  if exists (
    select 1 from public.timesheets timesheet
    where timesheet.employee_id = explanation_row.employee_id
      and timesheet.work_date = explanation_row.attendance_date
      and timesheet.status = 'LOCKED'
  ) then
    raise exception 'Ngày công đã khóa.';
  end if;

  update public.attendance_explanations
  set status = p_status,
      manager_note = coalesce(p_note, ''),
      approver_id = actor_id,
      updated_at = clock_timestamp()
  where id = p_id;

  update public.timesheets
  set status = case when p_status = 'Approved' then 'APPROVED' else 'EXCEPTION' end,
      updated_at = clock_timestamp()
  where employee_id = explanation_row.employee_id
    and work_date = explanation_row.attendance_date
    and status <> 'LOCKED';

  insert into public.audit_logs(
    actor_employee_id, target_employee_id, action,
    entity_type, entity_id, reason, metadata
  ) values (
    actor_id,
    explanation_row.employee_id,
    'ATTENDANCE_REQUEST_' || upper(p_status),
    'attendance_explanation',
    explanation_row.id::text,
    coalesce(p_note, ''),
    jsonb_build_object('attendance_date', explanation_row.attendance_date, 'origin', 'legacy')
  );
end;
$$;

revoke all on function public.review_attendance_explanation(uuid, text, text) from public, anon;
grant execute on function public.review_attendance_explanation(uuid, text, text) to authenticated;
