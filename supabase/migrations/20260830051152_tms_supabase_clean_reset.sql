-- genAi TMS: Supabase Auth + Postgres/RLS + transactional attendance RPCs.
-- Destructive reset approved on 2026-08-30: legacy public TMS rows are discarded.
-- Supabase Auth users are preserved; only public application tables are rebuilt.

create extension if not exists pgcrypto with schema extensions;

drop table if exists public.attendance_qr_sessions cascade;
drop table if exists public.attendance cascade;
drop table if exists public.config_shifts cascade;
drop table if exists public.config_system cascade;
drop table if exists public.locations cascade;
drop table if exists public.employees cascade;
drop schema if exists tms_private cascade;

create schema tms_private;
revoke all on schema tms_private from public, anon, authenticated;

create table public.employees (
  employee_id text primary key,
  auth_user_id uuid unique references auth.users(id) on delete set null,
  name text not null,
  email text not null,
  phone text,
  role text not null default 'Staff'
    check (role in ('Staff', 'Leader', 'Manager', 'Director', 'Admin', 'HR', 'Kiosk')),
  center_id text not null,
  allowed_locations text[] not null default '{}',
  position text,
  department text,
  avatar_url text,
  face_ref_url text,
  status text not null default 'Active' check (status in ('Active', 'Inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.locations (
  center_id text primary key,
  center_name text not null,
  address text,
  city text,
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  radius_meters integer not null default 200 check (radius_meters between 20 and 1000),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.config_shifts (
  id bigint generated always as identity primary key,
  name text not null unique,
  start_time time not null,
  end_time time not null,
  break_point time not null,
  sort_order integer not null default 0,
  active boolean not null default true
);

create table public.config_system (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

create table public.attendance (
  id text primary key,
  attendance_date date not null,
  employee_id text not null references public.employees(employee_id) on delete restrict,
  employee_name text not null,
  center_id text not null references public.locations(center_id) on delete restrict,
  location_name text not null,
  shift_name text not null,
  shift_start text not null,
  shift_end text not null,
  time_in text not null,
  time_out text not null default '',
  checkin_type text not null default 'QR_GPS' check (checkin_type = 'QR_GPS'),
  checkin_lat double precision not null,
  checkin_lng double precision not null,
  distance_meters double precision not null,
  location_accuracy_m double precision not null,
  checkout_lat double precision,
  checkout_lng double precision,
  checkout_distance double precision,
  checkout_accuracy_m double precision,
  qr_station_id uuid not null,
  late_minutes integer not null default 0,
  early_minutes integer not null default 0,
  work_hours numeric(6,2) not null default 0,
  status text not null default 'Valid' check (status in ('Valid', 'Late', 'Invalid')),
  is_valid text not null default 'Yes' check (is_valid in ('Yes', 'No')),
  note text not null default '',
  checked_in_at timestamptz not null,
  checked_out_at timestamptz,
  qr_verified_at timestamptz not null,
  last_updated timestamptz not null default now(),
  unique (employee_id, attendance_date)
);

create index attendance_employee_date_idx
  on public.attendance (employee_id, attendance_date desc);

create table public.attendance_qr_sessions (
  station_user_id uuid primary key references auth.users(id) on delete cascade,
  center_id text not null references public.locations(center_id) on delete cascade,
  token_hash text not null,
  created_by text not null references public.employees(employee_id) on delete cascade,
  issued_at timestamptz not null,
  expires_at timestamptz not null
);

insert into public.config_shifts (name, start_time, end_time, break_point, sort_order)
values
  ('Ca Sáng', '08:30', '12:00', '13:00', 10),
  ('Ca Chiều', '14:00', '17:30', '17:30', 20),
  ('Ca Tối', '17:30', '21:00', '23:59', 30);

insert into public.config_system (key, value)
values
  ('LATE_TOLERANCE', '15'),
  ('LUNCH_START', '12:00'),
  ('LUNCH_END', '13:30'),
  ('MAX_DISTANCE_METERS', '200');

alter table public.employees enable row level security;
alter table public.locations enable row level security;
alter table public.config_shifts enable row level security;
alter table public.config_system enable row level security;
alter table public.attendance enable row level security;
alter table public.attendance_qr_sessions enable row level security;

create policy employee_reads_own_profile
  on public.employees for select to authenticated
  using (auth.uid() = auth_user_id);

create policy employee_reads_own_attendance
  on public.attendance for select to authenticated
  using (
    employee_id = (
      select e.employee_id
      from public.employees e
      where e.auth_user_id = auth.uid()
    )
  );

revoke all on public.employees, public.locations, public.config_shifts,
  public.config_system, public.attendance, public.attendance_qr_sessions
  from public, anon, authenticated;
grant select on public.employees, public.attendance to authenticated;

-- Lock every legacy CRM/LMS table behind RLS. They are outside the reduced TMS scope.
do $$
declare
  table_name text;
begin
  for table_name in
    select tablename
    from pg_catalog.pg_tables
    where schemaname = 'public'
      and tablename not in (
        'employees', 'locations', 'config_shifts', 'config_system',
        'attendance', 'attendance_qr_sessions'
      )
  loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('revoke all on table public.%I from anon, authenticated', table_name);
  end loop;
end
$$;

create function tms_private.distance_meters(
  lat1 double precision,
  lng1 double precision,
  lat2 double precision,
  lng2 double precision
) returns double precision
language sql immutable
set search_path = ''
as $$
  select 6371000 * 2 * asin(sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2) +
    cos(radians(lat1)) * cos(radians(lat2)) *
    power(sin(radians(lng2 - lng1) / 2), 2)
  ));
$$;

create function tms_private.employee_json(row_data public.employees)
returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', row_data.employee_id,
    'employee_id', row_data.employee_id,
    'uid', coalesce(row_data.auth_user_id::text, ''),
    'name', row_data.name,
    'email', row_data.email,
    'phone', coalesce(row_data.phone, ''),
    'role', row_data.role,
    'center_id', row_data.center_id,
    'allowed_locations', row_data.allowed_locations,
    'position', coalesce(row_data.position, ''),
    'department', coalesce(row_data.department, ''),
    'avatar_url', coalesce(row_data.avatar_url, row_data.face_ref_url, ''),
    'status', row_data.status
  );
$$;

create function tms_private.attendance_json(row_data public.attendance)
returns jsonb
language sql stable
set search_path = ''
as $$
  select to_jsonb(row_data)
    - 'attendance_date' - 'employee_name' - 'checked_in_at' - 'checked_out_at'
    || jsonb_build_object(
      'date', row_data.attendance_date::text,
      'name', row_data.employee_name,
      'timestamp', floor(extract(epoch from row_data.checked_in_at) * 1000),
      'last_updated', row_data.last_updated
    );
$$;

create function public.get_my_attendance()
returns jsonb
language plpgsql stable
security definer
set search_path = ''
as $$
declare
  employee_row public.employees%rowtype;
  history_json jsonb;
begin
  if auth.uid() is null then
    raise exception 'Vui lòng đăng nhập.';
  end if;

  select * into employee_row
  from public.employees
  where auth_user_id = auth.uid() and status = 'Active';

  if not found then
    raise exception 'Không tìm thấy hồ sơ nhân viên hoặc tài khoản đã bị vô hiệu hóa.';
  end if;

  select coalesce(jsonb_agg(tms_private.attendance_json(a) order by a.checked_in_at desc), '[]'::jsonb)
  into history_json
  from (
    select * from public.attendance
    where employee_id = employee_row.employee_id
    order by checked_in_at desc
    limit 120
  ) a;

  return jsonb_build_object(
    'profile', tms_private.employee_json(employee_row),
    'history', history_json,
    'serverTime', clock_timestamp()
  );
end;
$$;

create function public.create_attendance_qr(p_center_id text default null)
returns jsonb
language plpgsql volatile
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
begin
  if auth.uid() is null then raise exception 'Vui lòng đăng nhập.'; end if;

  select * into operator_row from public.employees
  where auth_user_id = auth.uid() and status = 'Active';
  if not found then raise exception 'Không tìm thấy hồ sơ nhân viên.'; end if;
  if operator_row.role not in ('Admin', 'Director', 'HR', 'Kiosk') then
    raise exception 'Tài khoản không có quyền mở trạm QR.';
  end if;

  requested_center := coalesce(nullif(trim(p_center_id), ''), operator_row.center_id);
  if operator_row.role <> 'Admin'
    and requested_center <> operator_row.center_id
    and not (requested_center = any(operator_row.allowed_locations)) then
    raise exception 'Bạn chỉ được mở trạm QR tại chi nhánh đã gán.';
  end if;

  select * into location_row from public.locations
  where center_id = requested_center and active;
  if not found then raise exception 'Chi nhánh chưa cấu hình vị trí.'; end if;

  raw_token := translate(encode(extensions.gen_random_bytes(24), 'base64'), E'+/\n', '-_');
  expiry := clock_timestamp() + interval '45 seconds';
  expiry_ms := floor(extract(epoch from expiry) * 1000);

  insert into public.attendance_qr_sessions
    (station_user_id, center_id, token_hash, created_by, issued_at, expires_at)
  values
    (auth.uid(), requested_center, encode(extensions.digest(raw_token, 'sha256'), 'hex'),
     operator_row.employee_id, clock_timestamp(), expiry)
  on conflict (station_user_id) do update set
    center_id = excluded.center_id,
    token_hash = excluded.token_hash,
    created_by = excluded.created_by,
    issued_at = excluded.issued_at,
    expires_at = excluded.expires_at;

  return jsonb_build_object(
    'payload', jsonb_build_object(
      'v', 1, 's', auth.uid(), 'c', requested_center,
      't', raw_token, 'e', expiry_ms
    )::text,
    'expiresAt', expiry_ms,
    'branchName', location_row.center_name
  );
end;
$$;

create function public.record_qr_attendance(
  p_qr_payload text,
  p_lat double precision,
  p_lng double precision,
  p_accuracy double precision
) returns jsonb
language plpgsql volatile
security definer
set search_path = ''
as $$
declare
  employee_row public.employees%rowtype;
  location_row public.locations%rowtype;
  session_row public.attendance_qr_sessions%rowtype;
  attendance_row public.attendance%rowtype;
  shift_row public.config_shifts%rowtype;
  qr jsonb;
  qr_station uuid;
  qr_center text;
  qr_token text;
  qr_expiry bigint;
  now_at timestamptz := clock_timestamp();
  local_date date;
  local_time time;
  local_time_text text;
  distance double precision;
  allowed_radius integer;
  late_tolerance integer;
  lunch_start time;
  lunch_end time;
  late_minutes integer;
  calculated_early_minutes integer;
  total_minutes numeric;
  lunch_overlap numeric;
begin
  if auth.uid() is null then raise exception 'Vui lòng đăng nhập.'; end if;
  if p_qr_payload is null or length(p_qr_payload) > 2048 then
    raise exception 'Mã QR không hợp lệ.';
  end if;

  begin
    qr := p_qr_payload::jsonb;
    qr_station := (qr->>'s')::uuid;
    qr_center := qr->>'c';
    qr_token := qr->>'t';
    qr_expiry := (qr->>'e')::bigint;
  exception when others then
    raise exception 'Mã QR không đúng định dạng genAi TMS.';
  end;

  if (qr->>'v')::integer <> 1 or qr_center is null or qr_token is null then
    raise exception 'Mã QR thiếu dữ liệu xác thực.';
  end if;
  if qr_expiry < floor(extract(epoch from now_at) * 1000) - 2000 then
    raise exception 'Mã QR đã hết hạn. Vui lòng quét mã mới.';
  end if;

  select * into session_row from public.attendance_qr_sessions
  where station_user_id = qr_station for update;
  if not found
    or session_row.center_id <> qr_center
    or session_row.expires_at < now_at
    or session_row.token_hash <> encode(extensions.digest(qr_token, 'sha256'), 'hex') then
    raise exception 'Mã QR đã đổi hoặc không còn hiệu lực.';
  end if;

  select * into employee_row from public.employees
  where auth_user_id = auth.uid() and status = 'Active';
  if not found then raise exception 'Không tìm thấy hồ sơ nhân viên.'; end if;
  if employee_row.role = 'Kiosk' then raise exception 'Tài khoản Kiosk không được chấm công.'; end if;

  if p_lat is null or p_lng is null or p_lat not between -90 and 90
    or p_lng not between -180 and 180 then
    raise exception 'Dữ liệu định vị không hợp lệ.';
  end if;
  if p_accuracy is null or p_accuracy <= 0 or p_accuracy > 150 then
    raise exception 'Độ chính xác GPS chưa đạt yêu cầu (%m). Hãy ra gần cửa sổ và thử lại.', round(coalesce(p_accuracy, 0));
  end if;
  if qr_center <> employee_row.center_id
    and not (qr_center = any(employee_row.allowed_locations)) then
    raise exception 'Bạn không được chấm công tại chi nhánh này.';
  end if;

  select * into location_row from public.locations
  where center_id = qr_center and active;
  if not found then raise exception 'Chi nhánh chưa cấu hình tọa độ hợp lệ.'; end if;

  allowed_radius := greatest(20, least(1000, location_row.radius_meters));
  distance := tms_private.distance_meters(p_lat, p_lng, location_row.latitude, location_row.longitude);
  if distance > allowed_radius then
    raise exception 'Bạn đang cách % %m; bán kính cho phép là %m.', location_row.center_name, round(distance), allowed_radius;
  end if;

  local_date := (now_at at time zone 'Asia/Ho_Chi_Minh')::date;
  local_time := (now_at at time zone 'Asia/Ho_Chi_Minh')::time(0);
  local_time_text := to_char(local_time, 'HH24:MI');
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(employee_row.employee_id || local_date::text));

  update public.attendance set
    time_out = '23:59', status = 'Invalid', is_valid = 'No',
    note = 'System: Tự đóng phiên quên check-out', last_updated = now_at
  where employee_id = employee_row.employee_id
    and attendance_date < local_date and time_out = '';

  select * into attendance_row from public.attendance
  where employee_id = employee_row.employee_id and attendance_date = local_date
  for update;

  if found and attendance_row.time_out <> '' then
    raise exception 'Bạn đã hoàn tất chấm công hôm nay.';
  end if;

  if found then
    lunch_start := coalesce((select value::time from public.config_system where key = 'LUNCH_START'), '12:00'::time);
    lunch_end := coalesce((select value::time from public.config_system where key = 'LUNCH_END'), '13:30'::time);
    total_minutes := greatest(0, extract(epoch from (local_time - attendance_row.time_in::time)) / 60);
    lunch_overlap := greatest(0, extract(epoch from (least(local_time, lunch_end) - greatest(attendance_row.time_in::time, lunch_start))) / 60);
    calculated_early_minutes := greatest(0, extract(epoch from (attendance_row.shift_end::time - local_time)) / 60)::integer;

    update public.attendance set
      time_out = local_time_text,
      checkout_lat = p_lat,
      checkout_lng = p_lng,
      checkout_distance = distance,
      checkout_accuracy_m = p_accuracy,
      early_minutes = calculated_early_minutes,
      work_hours = round(greatest(0, total_minutes - lunch_overlap) / 60, 2),
      checked_out_at = now_at,
      qr_verified_at = now_at,
      last_updated = now_at
    where id = attendance_row.id
    returning * into attendance_row;

    return jsonb_build_object(
      'action', 'checkout',
      'message', 'Check-out thành công tại ' || location_row.center_name || '.',
      'attendance', tms_private.attendance_json(attendance_row)
    );
  end if;

  select * into shift_row from public.config_shifts
  where active and local_time <= break_point
  order by sort_order, start_time limit 1;
  if not found then
    select * into shift_row from public.config_shifts where active order by sort_order desc limit 1;
  end if;
  if not found then raise exception 'Chưa cấu hình ca làm việc.'; end if;

  late_tolerance := coalesce((select value::integer from public.config_system where key = 'LATE_TOLERANCE'), 15);
  late_minutes := case
    when local_time > shift_row.start_time + make_interval(mins => late_tolerance)
    then extract(epoch from (local_time - shift_row.start_time))::integer / 60
    else 0
  end;

  insert into public.attendance (
    id, attendance_date, employee_id, employee_name, center_id, location_name,
    shift_name, shift_start, shift_end, time_in, checkin_lat, checkin_lng,
    distance_meters, location_accuracy_m, qr_station_id, late_minutes, status,
    checked_in_at, qr_verified_at, last_updated
  ) values (
    employee_row.employee_id || '_' || local_date::text,
    local_date, employee_row.employee_id, employee_row.name, qr_center, location_row.center_name,
    shift_row.name, to_char(shift_row.start_time, 'HH24:MI'), to_char(shift_row.end_time, 'HH24:MI'),
    local_time_text, p_lat, p_lng, distance, p_accuracy, qr_station, late_minutes,
    case when late_minutes > 0 then 'Late' else 'Valid' end,
    now_at, now_at, now_at
  ) returning * into attendance_row;

  return jsonb_build_object(
    'action', 'checkin',
    'message', 'Check-in thành công tại ' || location_row.center_name || '.',
    'attendance', tms_private.attendance_json(attendance_row)
  );
end;
$$;

revoke all on function public.get_my_attendance() from public, anon;
revoke all on function public.create_attendance_qr(text) from public, anon;
revoke all on function public.record_qr_attendance(text, double precision, double precision, double precision) from public, anon;
grant execute on function public.get_my_attendance() to authenticated;
grant execute on function public.create_attendance_qr(text) to authenticated;
grant execute on function public.record_qr_attendance(text, double precision, double precision, double precision) to authenticated;

revoke all on all functions in schema tms_private from public, anon, authenticated;
revoke all on all tables in schema tms_private from public, anon, authenticated;
