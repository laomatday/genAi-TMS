-- genAi TMS production readiness V3
-- P0: enforce trusted-device verification in every attendance write path.
-- P1: make shift_assignments + timesheets the canonical attendance source.
-- P2: expose a single employee dashboard RPC to reduce client round trips.
-- This migration is additive: legacy attendance rows are preserved for audit/migration only.

begin;

alter table public.timesheets
  add column if not exists break_started_at timestamptz,
  add column if not exists break_minutes integer not null default 0
    check (break_minutes between 0 and 1440);

create index if not exists timesheets_employee_work_date_idx
  on public.timesheets(employee_id, work_date desc);

insert into public.config_system(key, value)
values
  ('DASHBOARD_HISTORY_DAYS', '120'),
  ('DEVICE_GRANT_HOURS', '12')
on conflict (key) do nothing;

create or replace function tms_private.resolve_schedule_v3(
  p_employee_id text,
  p_work_date date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  employee_row public.employees%rowtype;
  policy_row public.attendance_policies%rowtype;
  assignment_row public.shift_assignments%rowtype;
  shift_row public.config_shifts%rowtype;
  expected_start_at timestamptz;
  expected_end_at timestamptz;
  workday boolean := false;
  assigned_location text;
begin
  select * into employee_row
  from public.employees
  where employee_id = p_employee_id and status = 'Active';
  if not found then return null; end if;

  select * into policy_row
  from public.attendance_policies
  where id = employee_row.attendance_policy_id and active;
  if not found then
    select * into policy_row
    from public.attendance_policies
    where active
    order by created_at
    limit 1;
  end if;
  if not found then return null; end if;

  select * into assignment_row
  from public.shift_assignments
  where employee_id = p_employee_id and work_date = p_work_date;

  if found then
    select * into shift_row
    from public.config_shifts
    where id = assignment_row.shift_id and active;
    if not found then return null; end if;

    expected_start_at := ((p_work_date + shift_row.start_time) at time zone 'Asia/Ho_Chi_Minh');
    expected_end_at := (
      (p_work_date + shift_row.end_time
        + case when shift_row.end_time <= shift_row.start_time then interval '1 day' else interval '0 day' end)
      at time zone 'Asia/Ho_Chi_Minh'
    );
    workday := true;
    assigned_location := assignment_row.location_id;
  else
    expected_start_at := ((p_work_date + policy_row.expected_start) at time zone 'Asia/Ho_Chi_Minh');
    expected_end_at := (
      (p_work_date + policy_row.expected_end
        + case when policy_row.expected_end <= policy_row.expected_start then interval '1 day' else interval '0 day' end)
      at time zone 'Asia/Ho_Chi_Minh'
    );
    workday := extract(isodow from p_work_date)::smallint = any(policy_row.work_days);
    assigned_location := null;
  end if;

  return jsonb_build_object(
    'policy_id', policy_row.id,
    'shift_assignment_id', case when assignment_row.id is null then null else assignment_row.id end,
    'shift_id', case when assignment_row.id is null then null else assignment_row.shift_id end,
    'shift_name', case when assignment_row.id is null then policy_row.name else shift_row.name end,
    'location_id', assigned_location,
    'expected_start', expected_start_at,
    'expected_end', expected_end_at,
    'workday', workday,
    'late_tolerance_minutes', policy_row.late_tolerance_minutes,
    'early_tolerance_minutes', policy_row.early_tolerance_minutes,
    'checkin_window_start', policy_row.checkin_window_start,
    'checkin_window_end', policy_row.checkin_window_end,
    'checkout_window_start', policy_row.checkout_window_start,
    'checkout_window_end', policy_row.checkout_window_end,
    'gps_good_accuracy_m', policy_row.gps_good_accuracy_m,
    'gps_max_accuracy_m', policy_row.gps_max_accuracy_m,
    'unpaid_break_minutes', policy_row.unpaid_break_minutes,
    'auto_approve', policy_row.auto_approve
  );
end;
$$;

revoke all on function tms_private.resolve_schedule_v3(text, date) from public, anon, authenticated;

create or replace function tms_private.timesheet_attendance_json_v3(p_timesheet_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  timesheet_row public.timesheets%rowtype;
  employee_row public.employees%rowtype;
  location_row public.locations%rowtype;
  policy_row public.attendance_policies%rowtype;
  assignment_row public.shift_assignments%rowtype;
  shift_row public.config_shifts%rowtype;
  checkin_event public.attendance_events%rowtype;
  checkout_event public.attendance_events%rowtype;
  shift_name_value text;
  location_name_value text;
  display_status text;
  valid_value text;
begin
  select * into timesheet_row from public.timesheets where id = p_timesheet_id;
  if not found then return null; end if;

  select * into employee_row from public.employees where employee_id = timesheet_row.employee_id;
  select * into location_row from public.locations where center_id = timesheet_row.location_id;
  select * into policy_row from public.attendance_policies where id = timesheet_row.policy_id;
  select * into assignment_row
  from public.shift_assignments
  where employee_id = timesheet_row.employee_id and work_date = timesheet_row.work_date;
  if found then
    select * into shift_row from public.config_shifts where id = assignment_row.shift_id;
  end if;
  if timesheet_row.checkin_event_id is not null then
    select * into checkin_event from public.attendance_events where id = timesheet_row.checkin_event_id;
  end if;
  if timesheet_row.checkout_event_id is not null then
    select * into checkout_event from public.attendance_events where id = timesheet_row.checkout_event_id;
  end if;

  shift_name_value := coalesce(shift_row.name, policy_row.name, 'Ca làm việc');
  location_name_value := coalesce(location_row.center_name, timesheet_row.location_id, employee_row.center_id);
  display_status := case
    when timesheet_row.status in ('EXCEPTION', 'REJECTED') then 'Invalid'
    when timesheet_row.late_minutes > 0 then 'Late'
    else 'Valid'
  end;
  valid_value := case when display_status = 'Invalid' then 'No' else 'Yes' end;

  return jsonb_build_object(
    'id', timesheet_row.id::text,
    'date', timesheet_row.work_date::text,
    'employee_id', timesheet_row.employee_id,
    'name', employee_row.name,
    'center_id', coalesce(timesheet_row.location_id, employee_row.center_id),
    'location_name', location_name_value,
    'shift_name', shift_name_value,
    'shift_start', coalesce(to_char(timesheet_row.expected_start at time zone 'Asia/Ho_Chi_Minh', 'HH24:MI'), ''),
    'shift_end', coalesce(to_char(timesheet_row.expected_end at time zone 'Asia/Ho_Chi_Minh', 'HH24:MI'), ''),
    'time_in', coalesce(to_char(timesheet_row.actual_checkin at time zone 'Asia/Ho_Chi_Minh', 'HH24:MI'), ''),
    'time_out', coalesce(to_char(timesheet_row.actual_checkout at time zone 'Asia/Ho_Chi_Minh', 'HH24:MI'), ''),
    'checkin_type', 'QR_GPS',
    'checkin_lat', coalesce(checkin_event.latitude, 0),
    'checkin_lng', coalesce(checkin_event.longitude, 0),
    'distance_meters', coalesce(checkin_event.distance_meters, 0),
    'location_accuracy_m', checkin_event.gps_accuracy_m,
    'checkout_lat', checkout_event.latitude,
    'checkout_lng', checkout_event.longitude,
    'checkout_distance', checkout_event.distance_meters,
    'checkout_accuracy_m', checkout_event.gps_accuracy_m,
    'qr_station_id', coalesce(checkout_event.qr_station_id, checkin_event.qr_station_id),
    'device_id', coalesce(checkout_event.trusted_device_id, checkin_event.trusted_device_id),
    'late_minutes', timesheet_row.late_minutes,
    'early_minutes', timesheet_row.early_minutes,
    'work_hours', round(timesheet_row.work_minutes::numeric / 60, 2),
    'status', display_status,
    'is_valid', valid_value,
    'note', array_to_string(coalesce(timesheet_row.exception_codes, '{}'::text[]), ', '),
    'timestamp', floor(extract(epoch from coalesce(timesheet_row.actual_checkin, timesheet_row.expected_start, timesheet_row.created_at)) * 1000),
    'last_updated', timesheet_row.updated_at,
    'break_start', timesheet_row.break_started_at,
    'total_break_mins', timesheet_row.break_minutes
  );
end;
$$;

revoke all on function tms_private.timesheet_attendance_json_v3(uuid) from public, anon, authenticated;

create or replace function public.record_qr_attendance_v3(
  p_qr_payload text,
  p_lat double precision,
  p_lng double precision,
  p_accuracy double precision,
  p_device_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  employee_row public.employees%rowtype;
  location_row public.locations%rowtype;
  session_row public.attendance_qr_sessions%rowtype;
  timesheet_row public.timesheets%rowtype;
  schedule jsonb;
  qr jsonb;
  qr_station uuid;
  qr_center text;
  qr_token text;
  qr_expiry bigint;
  now_at timestamptz := clock_timestamp();
  local_date date;
  local_time time;
  expected_start_at timestamptz;
  expected_end_at timestamptz;
  policy_id_value uuid;
  assigned_location text;
  late_tolerance integer;
  early_tolerance integer;
  gps_good integer;
  gps_max integer;
  unpaid_break integer;
  auto_approve_value boolean;
  workday boolean;
  distance double precision;
  gps_state text := 'VALID';
  device_ok boolean := false;
  has_timesheet boolean := false;
  codes text[] := '{}'::text[];
  late_minutes_value integer := 0;
  early_minutes_value integer := 0;
  work_minutes_value integer := 0;
  break_minutes_value integer := 0;
  event_id uuid;
begin
  if (select auth.uid()) is null then raise exception 'Vui lòng đăng nhập.'; end if;
  if p_qr_payload is null or length(p_qr_payload) > 2048 then
    return jsonb_build_object('success', false, 'code', 'QR_INVALID', 'message', 'Mã QR không hợp lệ.');
  end if;

  select * into employee_row
  from public.employees
  where auth_user_id = (select auth.uid()) and status = 'Active';
  if not found then raise exception 'Không tìm thấy hồ sơ nhân viên.'; end if;
  if employee_row.role = 'Kiosk' then raise exception 'Tài khoản Kiosk không được chấm công cá nhân.'; end if;

  if employee_row.role = 'Admin' then
    device_ok := true;
  else
    select exists(
      select 1
      from public.trusted_device_grants grant_row
      join public.trusted_devices device_row
        on device_row.employee_id = grant_row.employee_id
       and device_row.device_id = grant_row.device_id
       and device_row.status = 'ACTIVE'
      where grant_row.employee_id = employee_row.employee_id
        and grant_row.device_id = p_device_id
        and grant_row.expires_at > now_at
    ) into device_ok;
  end if;
  if not device_ok then
    return jsonb_build_object('success', false, 'code', 'DEVICE_NOT_VERIFIED', 'message', 'Thiết bị chưa được xác thực. Vui lòng đăng nhập lại hoặc liên hệ Admin.');
  end if;

  begin
    qr := p_qr_payload::jsonb;
    qr_station := (qr ->> 's')::uuid;
    qr_center := qr ->> 'c';
    qr_token := qr ->> 't';
    qr_expiry := (qr ->> 'e')::bigint;
  exception when others then
    return jsonb_build_object('success', false, 'code', 'QR_INVALID', 'message', 'Mã QR không đúng định dạng genAi TMS.');
  end;

  if coalesce((qr ->> 'v')::integer, 0) <> 1 or qr_center is null or qr_token is null then
    return jsonb_build_object('success', false, 'code', 'QR_INVALID', 'message', 'Mã QR thiếu dữ liệu xác thực.');
  end if;
  if qr_expiry < floor(extract(epoch from now_at) * 1000) - 2000 then
    return jsonb_build_object('success', false, 'code', 'QR_EXPIRED', 'message', 'Mã QR đã hết hạn. Vui lòng quét mã mới.');
  end if;

  select * into session_row
  from public.attendance_qr_sessions
  where station_user_id = qr_station;
  if not found
    or session_row.center_id <> qr_center
    or session_row.expires_at < now_at
    or session_row.token_hash <> encode(extensions.digest(qr_token, 'sha256'), 'hex') then
    return jsonb_build_object('success', false, 'code', 'QR_EXPIRED', 'message', 'Mã QR đã đổi hoặc không còn hiệu lực.');
  end if;

  local_date := (now_at at time zone 'Asia/Ho_Chi_Minh')::date;
  local_time := (now_at at time zone 'Asia/Ho_Chi_Minh')::time;
  schedule := tms_private.resolve_schedule_v3(employee_row.employee_id, local_date);
  if schedule is null then
    return jsonb_build_object('success', false, 'code', 'POLICY_MISSING', 'message', 'Tài khoản chưa được gán chính sách chấm công hợp lệ.');
  end if;

  policy_id_value := (schedule ->> 'policy_id')::uuid;
  assigned_location := nullif(schedule ->> 'location_id', '');
  expected_start_at := (schedule ->> 'expected_start')::timestamptz;
  expected_end_at := (schedule ->> 'expected_end')::timestamptz;
  late_tolerance := coalesce((schedule ->> 'late_tolerance_minutes')::integer, 5);
  early_tolerance := coalesce((schedule ->> 'early_tolerance_minutes')::integer, 5);
  gps_good := coalesce((schedule ->> 'gps_good_accuracy_m')::integer, 50);
  gps_max := coalesce((schedule ->> 'gps_max_accuracy_m')::integer, 150);
  unpaid_break := coalesce((schedule ->> 'unpaid_break_minutes')::integer, 0);
  auto_approve_value := coalesce((schedule ->> 'auto_approve')::boolean, true);
  workday := coalesce((schedule ->> 'workday')::boolean, false);

  if assigned_location is not null and qr_center <> assigned_location then
    return jsonb_build_object('success', false, 'code', 'SHIFT_LOCATION_MISMATCH', 'message', 'Ca hôm nay đã được phân tại địa điểm khác. Vui lòng quét đúng trạm của ca được phân.');
  end if;
  if qr_center <> employee_row.center_id
    and not (qr_center = any(coalesce(employee_row.allowed_locations, '{}'::text[]))) then
    return jsonb_build_object('success', false, 'code', 'LOCATION_NOT_ALLOWED', 'message', 'Bạn không được chấm công tại địa điểm này.');
  end if;

  select * into location_row
  from public.locations
  where center_id = qr_center and active;
  if not found then
    return jsonb_build_object('success', false, 'code', 'LOCATION_MISSING', 'message', 'Địa điểm chưa cấu hình GPS.');
  end if;

  if p_lat is null or p_lng is null
    or p_lat not between -90 and 90
    or p_lng not between -180 and 180
    or p_accuracy is null or p_accuracy <= 0 then
    return jsonb_build_object('success', false, 'code', 'GPS_INVALID', 'message', 'Dữ liệu định vị không hợp lệ.');
  end if;

  distance := tms_private.distance_meters(p_lat, p_lng, location_row.latitude, location_row.longitude);
  if p_accuracy > gps_max then gps_state := 'INVALID';
  elsif p_accuracy > gps_good then gps_state := 'UNCERTAIN';
  end if;

  if gps_state <> 'VALID' then
    insert into public.attendance_events(
      employee_id, event_type, occurred_at, work_date, location_id, qr_station_id,
      latitude, longitude, gps_accuracy_m, distance_meters, gps_state,
      trusted_device_id, device_verified, outcome, failure_code, validation
    ) values (
      employee_row.employee_id, 'FAILED_ATTEMPT', now_at, local_date, qr_center, qr_station,
      p_lat, p_lng, p_accuracy, distance, gps_state,
      p_device_id, device_ok, gps_state,
      case when gps_state = 'UNCERTAIN' then 'GPS_UNCERTAIN' else 'GPS_ACCURACY' end,
      jsonb_build_object('good_accuracy', gps_good, 'max_accuracy', gps_max)
    );
    return jsonb_build_object(
      'success', false,
      'code', case when gps_state = 'UNCERTAIN' then 'GPS_UNCERTAIN' else 'GPS_ACCURACY' end,
      'message', 'GPS chưa đủ chính xác (' || round(p_accuracy) || 'm). Hãy ra vị trí thoáng và thử lại.'
    );
  end if;

  if distance > greatest(20, location_row.radius_meters) then
    insert into public.attendance_events(
      employee_id, event_type, occurred_at, work_date, location_id, qr_station_id,
      latitude, longitude, gps_accuracy_m, distance_meters, gps_state,
      trusted_device_id, device_verified, outcome, failure_code, validation
    ) values (
      employee_row.employee_id, 'FAILED_ATTEMPT', now_at, local_date, qr_center, qr_station,
      p_lat, p_lng, p_accuracy, distance, 'INVALID',
      p_device_id, device_ok, 'INVALID', 'OUTSIDE_GEOFENCE',
      jsonb_build_object('radius', location_row.radius_meters)
    );
    return jsonb_build_object('success', false, 'code', 'OUTSIDE_GEOFENCE',
      'message', 'Bạn đang cách ' || location_row.center_name || ' ' || round(distance) || 'm; bán kính cho phép là ' || location_row.radius_meters || 'm.');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(employee_row.employee_id || ':' || local_date::text));

  select * into timesheet_row
  from public.timesheets
  where employee_id = employee_row.employee_id and work_date = local_date
  for update;
  has_timesheet := found;

  if has_timesheet and timesheet_row.status = 'LOCKED' then
    return jsonb_build_object('success', false, 'code', 'LOCKED', 'message', 'Ngày công đã khóa.');
  end if;

  if not has_timesheet or timesheet_row.actual_checkin is null then
    codes := case when has_timesheet then coalesce(timesheet_row.exception_codes, '{}'::text[]) else '{}'::text[] end;
    codes := array_remove(codes, 'MISSING_CHECKIN');
    if not workday and not ('UNSCHEDULED_DAY' = any(codes)) then codes := array_append(codes, 'UNSCHEDULED_DAY'); end if;
    if now_at > expected_start_at + make_interval(mins => late_tolerance) then
      late_minutes_value := greatest(0, floor(extract(epoch from (now_at - expected_start_at)) / 60)::integer);
      if not ('LATE' = any(codes)) then codes := array_append(codes, 'LATE'); end if;
    end if;

    if has_timesheet then
      update public.timesheets
      set policy_id = policy_id_value,
          location_id = qr_center,
          expected_start = expected_start_at,
          expected_end = expected_end_at,
          actual_checkin = now_at,
          actual_checkout = null,
          status = 'OPEN',
          exception_codes = codes,
          late_minutes = late_minutes_value,
          early_minutes = 0,
          work_minutes = 0,
          updated_at = now_at
      where id = timesheet_row.id
      returning * into timesheet_row;
    else
      insert into public.timesheets(
        employee_id, work_date, policy_id, location_id,
        expected_start, expected_end, actual_checkin, status,
        exception_codes, late_minutes, updated_at
      ) values (
        employee_row.employee_id, local_date, policy_id_value, qr_center,
        expected_start_at, expected_end_at, now_at, 'OPEN',
        codes, late_minutes_value, now_at
      ) returning * into timesheet_row;
    end if;

    insert into public.attendance_events(
      timesheet_id, employee_id, event_type, occurred_at, work_date, location_id, qr_station_id,
      latitude, longitude, gps_accuracy_m, distance_meters, gps_state,
      trusted_device_id, device_verified, outcome, validation
    ) values (
      timesheet_row.id, employee_row.employee_id, 'CHECK_IN', now_at, local_date, qr_center, qr_station,
      p_lat, p_lng, p_accuracy, distance, 'VALID',
      p_device_id, device_ok, 'VALID',
      jsonb_build_object(
        'policy_id', policy_id_value,
        'shift_assignment_id', schedule ->> 'shift_assignment_id',
        'shift_name', schedule ->> 'shift_name',
        'radius', location_row.radius_meters,
        'qr_verified', true,
        'trusted_device_verified', true
      )
    ) returning id into event_id;

    update public.timesheets
    set checkin_event_id = event_id, updated_at = now_at
    where id = timesheet_row.id
    returning * into timesheet_row;

    return jsonb_build_object(
      'success', true,
      'action', 'checkin',
      'message', 'Check-in thành công tại ' || location_row.center_name || '.',
      'attendance', tms_private.timesheet_attendance_json_v3(timesheet_row.id)
    );
  end if;

  if timesheet_row.actual_checkout is not null then
    return jsonb_build_object('success', false, 'code', 'ALREADY_COMPLETE', 'message', 'Bạn đã hoàn tất chấm công hôm nay.');
  end if;

  codes := coalesce(timesheet_row.exception_codes, '{}'::text[]);
  if now_at < expected_end_at - make_interval(mins => early_tolerance) then
    early_minutes_value := greatest(0, floor(extract(epoch from (expected_end_at - now_at)) / 60)::integer);
    if not ('EARLY_LEAVE' = any(codes)) then codes := array_append(codes, 'EARLY_LEAVE'); end if;
  end if;

  break_minutes_value := coalesce(timesheet_row.break_minutes, 0);
  if timesheet_row.break_started_at is not null then
    break_minutes_value := break_minutes_value
      + greatest(0, floor(extract(epoch from (now_at - timesheet_row.break_started_at)) / 60)::integer);
  end if;

  work_minutes_value := greatest(0, floor(extract(epoch from (now_at - timesheet_row.actual_checkin)) / 60)::integer - break_minutes_value);
  if work_minutes_value >= 360 then
    work_minutes_value := greatest(0, work_minutes_value - unpaid_break);
  end if;

  insert into public.attendance_events(
    timesheet_id, employee_id, event_type, occurred_at, work_date, location_id, qr_station_id,
    latitude, longitude, gps_accuracy_m, distance_meters, gps_state,
    trusted_device_id, device_verified, outcome, validation
  ) values (
    timesheet_row.id, employee_row.employee_id, 'CHECK_OUT', now_at, local_date, qr_center, qr_station,
    p_lat, p_lng, p_accuracy, distance, 'VALID',
    p_device_id, device_ok, 'VALID',
    jsonb_build_object(
      'policy_id', policy_id_value,
      'shift_assignment_id', schedule ->> 'shift_assignment_id',
      'shift_name', schedule ->> 'shift_name',
      'radius', location_row.radius_meters,
      'qr_verified', true,
      'trusted_device_verified', true
    )
  ) returning id into event_id;

  update public.timesheets
  set actual_checkout = now_at,
      checkout_event_id = event_id,
      early_minutes = early_minutes_value,
      work_minutes = work_minutes_value,
      break_minutes = break_minutes_value,
      break_started_at = null,
      exception_codes = codes,
      status = case
        when coalesce(array_length(codes, 1), 0) = 0 and auto_approve_value then 'AUTO_APPROVED'
        when coalesce(array_length(codes, 1), 0) = 0 then 'COMPLETE'
        else 'EXCEPTION'
      end,
      updated_at = now_at
  where id = timesheet_row.id
  returning * into timesheet_row;

  return jsonb_build_object(
    'success', true,
    'action', 'checkout',
    'message', 'Check-out thành công tại ' || location_row.center_name || '.',
    'attendance', tms_private.timesheet_attendance_json_v3(timesheet_row.id)
  );
end;
$$;

revoke all on function public.record_qr_attendance_v3(text, double precision, double precision, double precision, text) from public, anon;
grant execute on function public.record_qr_attendance_v3(text, double precision, double precision, double precision, text) to authenticated;

create or replace function public.checkout_attendance_gps_v3(
  p_lat double precision,
  p_lng double precision,
  p_accuracy double precision,
  p_device_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  employee_row public.employees%rowtype;
  location_row public.locations%rowtype;
  timesheet_row public.timesheets%rowtype;
  schedule jsonb;
  now_at timestamptz := clock_timestamp();
  local_date date := (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date;
  expected_end_at timestamptz;
  early_tolerance integer;
  gps_good integer;
  gps_max integer;
  unpaid_break integer;
  auto_approve_value boolean;
  distance double precision;
  device_ok boolean := false;
  gps_state text := 'VALID';
  early_minutes_value integer := 0;
  work_minutes_value integer := 0;
  break_minutes_value integer := 0;
  codes text[] := '{}'::text[];
  event_id uuid;
begin
  if (select auth.uid()) is null then raise exception 'Vui lòng đăng nhập.'; end if;
  select * into employee_row
  from public.employees
  where auth_user_id = (select auth.uid()) and status = 'Active';
  if not found then raise exception 'Không tìm thấy hồ sơ nhân viên.'; end if;

  if employee_row.role = 'Admin' then
    device_ok := true;
  else
    select exists(
      select 1 from public.trusted_device_grants grant_row
      join public.trusted_devices device_row
        on device_row.employee_id = grant_row.employee_id
       and device_row.device_id = grant_row.device_id
       and device_row.status = 'ACTIVE'
      where grant_row.employee_id = employee_row.employee_id
        and grant_row.device_id = p_device_id
        and grant_row.expires_at > now_at
    ) into device_ok;
  end if;
  if not device_ok then
    return jsonb_build_object('success', false, 'code', 'DEVICE_NOT_VERIFIED', 'message', 'Thiết bị chưa được xác thực.');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(employee_row.employee_id || ':' || local_date::text));
  select * into timesheet_row
  from public.timesheets
  where employee_id = employee_row.employee_id and work_date = local_date
  for update;
  if not found or timesheet_row.actual_checkin is null then
    return jsonb_build_object('success', false, 'code', 'NO_ACTIVE_SESSION', 'message', 'Không tìm thấy phiên làm việc để Check-out.');
  end if;
  if timesheet_row.actual_checkout is not null or timesheet_row.status = 'LOCKED' then
    return jsonb_build_object('success', false, 'code', 'ALREADY_COMPLETE', 'message', 'Ngày công hôm nay đã hoàn tất hoặc đã khóa.');
  end if;

  schedule := tms_private.resolve_schedule_v3(employee_row.employee_id, local_date);
  if schedule is null then raise exception 'Không tìm thấy chính sách chấm công.'; end if;
  expected_end_at := (schedule ->> 'expected_end')::timestamptz;
  early_tolerance := coalesce((schedule ->> 'early_tolerance_minutes')::integer, 5);
  gps_good := coalesce((schedule ->> 'gps_good_accuracy_m')::integer, 50);
  gps_max := coalesce((schedule ->> 'gps_max_accuracy_m')::integer, 150);
  unpaid_break := coalesce((schedule ->> 'unpaid_break_minutes')::integer, 0);
  auto_approve_value := coalesce((schedule ->> 'auto_approve')::boolean, true);

  select * into location_row
  from public.locations
  where center_id = coalesce(timesheet_row.location_id, employee_row.center_id) and active;
  if not found then return jsonb_build_object('success', false, 'code', 'LOCATION_MISSING', 'message', 'Địa điểm chưa cấu hình GPS.'); end if;

  if p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180 or p_accuracy is null or p_accuracy <= 0 then
    return jsonb_build_object('success', false, 'code', 'GPS_INVALID', 'message', 'Dữ liệu định vị không hợp lệ.');
  end if;
  distance := tms_private.distance_meters(p_lat, p_lng, location_row.latitude, location_row.longitude);
  if p_accuracy > gps_max then gps_state := 'INVALID'; elsif p_accuracy > gps_good then gps_state := 'UNCERTAIN'; end if;
  if gps_state <> 'VALID' then
    return jsonb_build_object('success', false, 'code', 'GPS_ACCURACY', 'message', 'GPS chưa đủ chính xác (' || round(p_accuracy) || 'm).');
  end if;
  if distance > greatest(20, location_row.radius_meters) then
    return jsonb_build_object('success', false, 'code', 'OUTSIDE_GEOFENCE', 'message', 'Bạn đang ngoài phạm vi Check-out của ' || location_row.center_name || '.');
  end if;

  codes := coalesce(timesheet_row.exception_codes, '{}'::text[]);
  if now_at < expected_end_at - make_interval(mins => early_tolerance) then
    early_minutes_value := greatest(0, floor(extract(epoch from (expected_end_at - now_at)) / 60)::integer);
    if not ('EARLY_LEAVE' = any(codes)) then codes := array_append(codes, 'EARLY_LEAVE'); end if;
  end if;
  break_minutes_value := coalesce(timesheet_row.break_minutes, 0);
  if timesheet_row.break_started_at is not null then
    break_minutes_value := break_minutes_value + greatest(0, floor(extract(epoch from (now_at - timesheet_row.break_started_at)) / 60)::integer);
  end if;
  work_minutes_value := greatest(0, floor(extract(epoch from (now_at - timesheet_row.actual_checkin)) / 60)::integer - break_minutes_value);
  if work_minutes_value >= 360 then work_minutes_value := greatest(0, work_minutes_value - unpaid_break); end if;

  insert into public.attendance_events(
    timesheet_id, employee_id, event_type, occurred_at, work_date, location_id,
    latitude, longitude, gps_accuracy_m, distance_meters, gps_state,
    trusted_device_id, device_verified, outcome, validation
  ) values (
    timesheet_row.id, employee_row.employee_id, 'CHECK_OUT', now_at, local_date, location_row.center_id,
    p_lat, p_lng, p_accuracy, distance, 'VALID',
    p_device_id, device_ok, 'VALID',
    jsonb_build_object('trusted_device_verified', true, 'checkout_mode', 'GPS')
  ) returning id into event_id;

  update public.timesheets
  set actual_checkout = now_at,
      checkout_event_id = event_id,
      early_minutes = early_minutes_value,
      work_minutes = work_minutes_value,
      break_minutes = break_minutes_value,
      break_started_at = null,
      exception_codes = codes,
      status = case
        when coalesce(array_length(codes, 1), 0) = 0 and auto_approve_value then 'AUTO_APPROVED'
        when coalesce(array_length(codes, 1), 0) = 0 then 'COMPLETE'
        else 'EXCEPTION'
      end,
      updated_at = now_at
  where id = timesheet_row.id
  returning * into timesheet_row;

  return jsonb_build_object(
    'success', true,
    'action', 'checkout',
    'message', 'Check-out thành công tại ' || location_row.center_name || '.',
    'attendance', tms_private.timesheet_attendance_json_v3(timesheet_row.id)
  );
end;
$$;

revoke all on function public.checkout_attendance_gps_v3(double precision, double precision, double precision, text) from public, anon;
grant execute on function public.checkout_attendance_gps_v3(double precision, double precision, double precision, text) to authenticated;

create or replace function public.toggle_attendance_pause_v3()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  employee_row public.employees%rowtype;
  timesheet_row public.timesheets%rowtype;
  now_at timestamptz := clock_timestamp();
  local_date date := (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date;
  elapsed integer;
begin
  if (select auth.uid()) is null then raise exception 'Vui lòng đăng nhập.'; end if;
  select * into employee_row from public.employees where auth_user_id = (select auth.uid()) and status = 'Active';
  if not found then raise exception 'Không tìm thấy hồ sơ nhân viên.'; end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(employee_row.employee_id || ':' || local_date::text));
  select * into timesheet_row
  from public.timesheets
  where employee_id = employee_row.employee_id and work_date = local_date
  for update;
  if not found or timesheet_row.actual_checkin is null then raise exception 'Bạn chưa Check-in hôm nay.'; end if;
  if timesheet_row.actual_checkout is not null or timesheet_row.status = 'LOCKED' then raise exception 'Ngày công hôm nay đã hoàn tất.'; end if;

  if timesheet_row.break_started_at is null then
    update public.timesheets
    set break_started_at = now_at, updated_at = now_at
    where id = timesheet_row.id;
    return jsonb_build_object('success', true, 'action', 'pause', 'message', 'Đã bắt đầu tạm dừng.');
  end if;

  elapsed := greatest(0, floor(extract(epoch from (now_at - timesheet_row.break_started_at)) / 60)::integer);
  update public.timesheets
  set break_minutes = least(1440, coalesce(break_minutes, 0) + elapsed),
      break_started_at = null,
      updated_at = now_at
  where id = timesheet_row.id;
  return jsonb_build_object('success', true, 'action', 'continue', 'message', 'Đã tiếp tục làm việc.');
end;
$$;

revoke all on function public.toggle_attendance_pause_v3() from public, anon;
grant execute on function public.toggle_attendance_pause_v3() to authenticated;

create or replace function public.submit_attendance_explanation_v3(
  p_attendance_date date,
  p_reason text
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
  schedule jsonb;
  local_today date := (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date;
  month_start date;
  target_month date;
  lock_day integer := 5;
  max_explanations integer := 5;
  existing_count integer := 0;
begin
  if (select auth.uid()) is null then raise exception 'Vui lòng đăng nhập.'; end if;
  select * into employee_row from public.employees where auth_user_id = (select auth.uid()) and status = 'Active';
  if not found then raise exception 'Không tìm thấy hồ sơ nhân viên.'; end if;
  if p_attendance_date is null or p_attendance_date > local_today then raise exception 'Ngày giải trình không hợp lệ.'; end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'Vui lòng nhập lý do.'; end if;

  select least(31, greatest(1, value::integer)) into lock_day
  from public.config_system where key = 'LOCK_DATE' and value ~ '^[0-9]+$';
  lock_day := coalesce(lock_day, 5);
  select least(100, greatest(1, value::integer)) into max_explanations
  from public.config_system where key = 'MAX_EXPLANATIONS_PER_MONTH' and value ~ '^[0-9]+$';
  max_explanations := coalesce(max_explanations, 5);

  month_start := date_trunc('month', local_today)::date;
  target_month := date_trunc('month', p_attendance_date)::date;
  if not (
    target_month = month_start
    or (target_month = (month_start - interval '1 month')::date and extract(day from local_today) <= lock_day)
  ) then raise exception 'Đã quá thời hạn giải trình ngày công.'; end if;

  select count(*) into existing_count
  from public.attendance_requests request
  join public.timesheets timesheet on timesheet.id = request.timesheet_id
  where request.employee_id = employee_row.employee_id
    and request.request_type = 'EXPLANATION'
    and request.status <> 'REJECTED'
    and date_trunc('month', timesheet.work_date::timestamp)::date = target_month;
  if existing_count >= max_explanations then raise exception 'Bạn đã đạt giới hạn % giải trình trong tháng này.', max_explanations; end if;

  select * into timesheet_row
  from public.timesheets
  where employee_id = employee_row.employee_id and work_date = p_attendance_date
  for update;

  if not found then
    schedule := tms_private.resolve_schedule_v3(employee_row.employee_id, p_attendance_date);
    if schedule is null then raise exception 'Không tìm thấy lịch làm việc cho ngày này.'; end if;
    insert into public.timesheets(
      employee_id, work_date, policy_id, location_id,
      expected_start, expected_end, status, exception_codes, updated_at
    ) values (
      employee_row.employee_id,
      p_attendance_date,
      (schedule ->> 'policy_id')::uuid,
      coalesce(nullif(schedule ->> 'location_id', ''), employee_row.center_id),
      (schedule ->> 'expected_start')::timestamptz,
      (schedule ->> 'expected_end')::timestamptz,
      'EXCEPTION',
      array['MISSING_CHECKIN'],
      clock_timestamp()
    ) returning * into timesheet_row;
  end if;

  if timesheet_row.status = 'LOCKED' then raise exception 'Ngày công đã khóa.'; end if;
  if exists(select 1 from public.attendance_requests request where request.timesheet_id = timesheet_row.id and request.status = 'PENDING') then
    raise exception 'Ngày này đã có yêu cầu đang chờ duyệt.';
  end if;

  insert into public.attendance_requests(
    timesheet_id, employee_id, request_type, exception_code, reason, status
  ) values (
    timesheet_row.id,
    employee_row.employee_id,
    'EXPLANATION',
    case when coalesce(array_length(timesheet_row.exception_codes, 1), 0) > 0 then timesheet_row.exception_codes[1] else null end,
    trim(p_reason),
    'PENDING'
  ) returning * into request_row;

  update public.timesheets set status = 'PENDING_REVIEW', updated_at = clock_timestamp() where id = timesheet_row.id;
  insert into public.audit_logs(actor_employee_id, target_employee_id, action, entity_type, entity_id, reason, metadata)
  values(employee_row.employee_id, employee_row.employee_id, 'ATTENDANCE_REQUEST_SUBMITTED', 'attendance_request', request_row.id::text, request_row.reason,
    jsonb_build_object('type', 'EXPLANATION', 'timesheet_id', timesheet_row.id, 'origin', 'v3'));
  return request_row;
end;
$$;

revoke all on function public.submit_attendance_explanation_v3(date, text) from public, anon;
grant execute on function public.submit_attendance_explanation_v3(date, text) to authenticated;

create or replace function public.get_my_dashboard_v3()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  employee_row public.employees%rowtype;
  policy_row public.attendance_policies%rowtype;
  history_json jsonb := '[]'::jsonb;
  requests_json jsonb := '[]'::jsonb;
  explanations_json jsonb := '[]'::jsonb;
  approvals_json jsonb := '[]'::jsonb;
  explanation_approvals_json jsonb := '[]'::jsonb;
  team_leaves_json jsonb := '[]'::jsonb;
  contacts_json jsonb := '[]'::jsonb;
  holidays_json jsonb := '[]'::jsonb;
  shifts_json jsonb := '[]'::jsonb;
  system_json jsonb;
  local_today date := (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date;
  month_start date;
  month_end date;
  standard_days integer := 0;
  work_days numeric := 0;
  leave_days integer := 0;
  late_mins integer := 0;
  error_count integer := 0;
  min_hours_full numeric := 7;
  min_hours_half numeric := 3.5;
  history_limit integer := 120;
begin
  if (select auth.uid()) is null then raise exception 'Vui lòng đăng nhập.'; end if;
  select * into employee_row
  from public.employees
  where auth_user_id = (select auth.uid()) and status = 'Active';
  if not found then raise exception 'Không tìm thấy hồ sơ nhân viên.'; end if;

  select * into policy_row
  from public.attendance_policies where id = employee_row.attendance_policy_id and active;
  if not found then select * into policy_row from public.attendance_policies where active order by created_at limit 1; end if;

  select least(365, greatest(30, value::integer)) into history_limit
  from public.config_system where key = 'DASHBOARD_HISTORY_DAYS' and value ~ '^[0-9]+$';
  history_limit := coalesce(history_limit, 120);

  select coalesce(jsonb_agg(tms_private.timesheet_attendance_json_v3(source.id) order by source.work_date desc), '[]'::jsonb)
  into history_json
  from (
    select id, work_date
    from public.timesheets
    where employee_id = employee_row.employee_id
    order by work_date desc
    limit history_limit
  ) source;

  select coalesce(jsonb_agg(to_jsonb(request_row) order by request_row.created_at desc), '[]'::jsonb)
  into requests_json
  from public.leave_requests request_row
  where request_row.employee_id = employee_row.employee_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', request_row.id::text,
    'employee_id', request_row.employee_id,
    'date', timesheet_row.work_date::text,
    'attendance_date', timesheet_row.work_date::text,
    'reason', request_row.reason,
    'status', case request_row.status when 'APPROVED' then 'Approved' when 'REJECTED' then 'Rejected' else 'Pending' end,
    'created_at', request_row.created_at,
    'manager_note', request_row.manager_note,
    'approver_id', request_row.approver_id,
    'updated_at', request_row.updated_at
  ) order by request_row.created_at desc), '[]'::jsonb)
  into explanations_json
  from public.attendance_requests request_row
  join public.timesheets timesheet_row on timesheet_row.id = request_row.timesheet_id
  where request_row.employee_id = employee_row.employee_id
    and request_row.request_type = 'EXPLANATION';

  select coalesce(jsonb_agg(to_jsonb(request_row) order by request_row.created_at desc), '[]'::jsonb)
  into approvals_json
  from public.leave_requests request_row
  where request_row.status = 'Pending'
    and request_row.employee_id <> employee_row.employee_id
    and (select tms_private.can_manage_employee(request_row.employee_id));

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', request_row.id::text,
    'employee_id', request_row.employee_id,
    'date', timesheet_row.work_date::text,
    'attendance_date', timesheet_row.work_date::text,
    'reason', request_row.reason,
    'status', 'Pending',
    'created_at', request_row.created_at,
    'manager_note', request_row.manager_note,
    'approver_id', request_row.approver_id,
    'updated_at', request_row.updated_at
  ) order by request_row.created_at desc), '[]'::jsonb)
  into explanation_approvals_json
  from public.attendance_requests request_row
  join public.timesheets timesheet_row on timesheet_row.id = request_row.timesheet_id
  where request_row.status = 'PENDING'
    and request_row.employee_id <> employee_row.employee_id
    and (select tms_private.can_manage_employee(request_row.employee_id));

  select coalesce(jsonb_agg(to_jsonb(request_row) order by request_row.created_at desc), '[]'::jsonb)
  into team_leaves_json
  from public.leave_requests request_row
  where request_row.status in ('Pending', 'Approved')
    and request_row.employee_id <> employee_row.employee_id
    and (select tms_private.can_manage_employee(request_row.employee_id));

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', directory.employee_id,
    'employee_id', directory.employee_id,
    'name', directory.name,
    'email', directory.email,
    'phone', directory.phone,
    'role', directory.role,
    'center_id', directory.center_id,
    'position', directory.position_title,
    'department', directory.department,
    'avatar_url', directory.avatar_url,
    'face_ref_url', directory.avatar_url,
    'direct_manager_id', directory.direct_manager_id,
    'status', 'Active'
  ) order by directory.name), '[]'::jsonb)
  into contacts_json
  from public.get_employee_directory() directory;

  select coalesce(jsonb_agg(to_jsonb(holiday_row) order by holiday_row.from_date), '[]'::jsonb)
  into holidays_json
  from public.holidays holiday_row where holiday_row.active;

  select coalesce(jsonb_agg(jsonb_build_object(
    'name', shift_row.name,
    'start', to_char(shift_row.start_time, 'HH24:MI'),
    'end', to_char(shift_row.end_time, 'HH24:MI'),
    'break_point', to_char(shift_row.break_point, 'HH24:MI')
  ) order by shift_row.sort_order), '[]'::jsonb)
  into shifts_json
  from public.config_shifts shift_row where shift_row.active;

  system_json := jsonb_build_object(
    'LATE_TOLERANCE', coalesce((select value::numeric from public.config_system where key = 'LATE_TOLERANCE' and value ~ '^[0-9]+([.][0-9]+)?$'), 15),
    'MIN_HOURS_FULL', coalesce((select value::numeric from public.config_system where key = 'MIN_HOURS_FULL' and value ~ '^[0-9]+([.][0-9]+)?$'), 7),
    'MIN_HOURS_HALF', coalesce((select value::numeric from public.config_system where key = 'MIN_HOURS_HALF' and value ~ '^[0-9]+([.][0-9]+)?$'), 3.5),
    'LUNCH_START', coalesce((select value from public.config_system where key = 'LUNCH_START'), '12:00'),
    'LUNCH_END', coalesce((select value from public.config_system where key = 'LUNCH_END'), '13:30'),
    'OFF_DAYS', coalesce((select to_jsonb(string_to_array(value, ',')::integer[]) from public.config_system where key = 'OFF_DAYS'), '[0]'::jsonb),
    'MAX_DISTANCE_METERS', coalesce((select value::numeric from public.config_system where key = 'MAX_DISTANCE_METERS' and value ~ '^[0-9]+$'), 200),
    'LOCK_DATE', coalesce((select value::numeric from public.config_system where key = 'LOCK_DATE' and value ~ '^[0-9]+$'), 5),
    'MAX_EXPLANATIONS_PER_MONTH', coalesce((select value::numeric from public.config_system where key = 'MAX_EXPLANATIONS_PER_MONTH' and value ~ '^[0-9]+$'), 5),
    'QR_REFRESH_SECONDS', coalesce((select value::numeric from public.config_system where key = 'QR_REFRESH_SECONDS' and value ~ '^[0-9]+$'), 30),
    'QR_VALIDITY_SECONDS', coalesce((select value::numeric from public.config_system where key = 'QR_VALIDITY_SECONDS' and value ~ '^[0-9]+$'), 45)
  );

  min_hours_full := coalesce((system_json ->> 'MIN_HOURS_FULL')::numeric, 7);
  min_hours_half := coalesce((system_json ->> 'MIN_HOURS_HALF')::numeric, 3.5);
  month_start := date_trunc('month', local_today)::date;
  month_end := (date_trunc('month', local_today::timestamp) + interval '1 month - 1 day')::date;

  if policy_row.id is not null then
    select count(*) into standard_days
    from generate_series(month_start, month_end, interval '1 day') day_row
    where extract(isodow from day_row)::smallint = any(policy_row.work_days)
      and not exists(
        select 1 from public.holidays holiday_row
        where holiday_row.active and holiday_row.paid
          and day_row::date between holiday_row.from_date and holiday_row.to_date
      );
  end if;

  select coalesce(sum(case
      when timesheet_row.status = 'APPROVED' then 1
      when timesheet_row.work_minutes >= min_hours_full * 60 then 1
      when timesheet_row.work_minutes >= min_hours_half * 60 then 0.5
      else 0
    end), 0),
    coalesce(sum(timesheet_row.late_minutes), 0),
    count(*) filter (where timesheet_row.status in ('EXCEPTION', 'REJECTED'))
  into work_days, late_mins, error_count
  from public.timesheets timesheet_row
  where timesheet_row.employee_id = employee_row.employee_id
    and timesheet_row.work_date between month_start and month_end;

  if policy_row.id is not null then
    select count(*) into leave_days
    from (
      select distinct day_row::date as leave_date
      from public.leave_requests request_row
      cross join lateral generate_series(
        greatest(request_row.from_date, month_start),
        least(request_row.to_date, month_end),
        interval '1 day'
      ) day_row
      where request_row.employee_id = employee_row.employee_id
        and request_row.status = 'Approved'
        and request_row.type in ('Nghỉ phép', 'Nghỉ ốm')
        and extract(isodow from day_row)::smallint = any(policy_row.work_days)
    ) counted_days;
  end if;

  return jsonb_build_object(
    'userProfile', jsonb_build_object(
      'id', employee_row.employee_id,
      'employee_id', employee_row.employee_id,
      'uid', coalesce(employee_row.auth_user_id::text, ''),
      'auth_user_id', employee_row.auth_user_id,
      'name', employee_row.name,
      'email', employee_row.email,
      'phone', employee_row.phone,
      'role', employee_row.role,
      'center_id', employee_row.center_id,
      'attendance_policy_id', employee_row.attendance_policy_id,
      'allowed_locations', coalesce(employee_row.allowed_locations, '{}'::text[]),
      'managed_locations', coalesce(employee_row.managed_locations, '{}'::text[]),
      'direct_manager_id', employee_row.direct_manager_id,
      'annual_leave_balance', employee_row.annual_leave_balance,
      'trusted_device_id', employee_row.trusted_device_id,
      'trusted_device_bound_at', employee_row.trusted_device_bound_at,
      'position', employee_row.position,
      'department', employee_row.department,
      'avatar_url', employee_row.avatar_url,
      'face_ref_url', employee_row.face_ref_url,
      'status', employee_row.status
    ),
    'history', jsonb_build_object(
      'history', history_json,
      'summary', jsonb_build_object(
        'workDays', work_days,
        'lateMins', late_mins,
        'leaveDays', leave_days,
        'remainingLeave', coalesce(employee_row.annual_leave_balance, 0),
        'standardDays', standard_days,
        'errorCount', error_count
      )
    ),
    'notifications', jsonb_build_object(
      'approvals', approvals_json,
      'explanationApprovals', explanation_approvals_json,
      'myRequests', requests_json,
      'myExplanations', explanations_json
    ),
    'myRequests', requests_json,
    'myExplanations', explanations_json,
    'teamLeaves', team_leaves_json,
    -- Server-side location validation is authoritative. The employee shell intentionally
    -- receives no geofence coordinates so it cannot falsely reject an allowed/assigned branch.
    'locations', '[]'::jsonb,
    'contacts', contacts_json,
    'holidays', holidays_json,
    'shifts', shifts_json,
    'systemConfig', system_json,
    'serverTime', clock_timestamp()
  );
end;
$$;

revoke all on function public.get_my_dashboard_v3() from public, anon;
grant execute on function public.get_my_dashboard_v3() to authenticated;

-- Legacy attendance mutation RPCs remain in the schema for historical compatibility,
-- but authenticated clients can no longer execute them after the V3 cut-over.
do $$
declare
  fn record;
begin
  for fn in
    select proc.oid, proc.proname
    from pg_catalog.pg_proc proc
    join pg_catalog.pg_namespace namespace_row on namespace_row.oid = proc.pronamespace
    where namespace_row.nspname = 'public'
      and proc.proname in (
        'record_qr_attendance',
        'record_qr_attendance_v2',
        'record_mobile_checkin',
        'record_mobile_checkout',
        'checkout_attendance_gps',
        'toggle_attendance_pause',
        'register_or_validate_trusted_device'
      )
  loop
    execute format(
      'revoke execute on function public.%I(%s) from authenticated',
      fn.proname,
      pg_catalog.pg_get_function_identity_arguments(fn.oid)
    );
  end loop;
end;
$$;

insert into public.audit_logs(action, entity_type, reason, metadata)
values(
  'SYSTEM_V3_CUTOVER_READY',
  'migration',
  'Bật canonical timesheets + trusted-device attendance V3',
  jsonb_build_object('migration', '20260906013000_production_readiness_v3')
);

commit;
