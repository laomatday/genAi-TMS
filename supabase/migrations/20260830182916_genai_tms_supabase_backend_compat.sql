-- Keep genAi TMS backend compatibility during the Supabase cutover.
begin;

alter table public.attendance
  add column if not exists device_id text not null default '',
  add column if not exists selfie_url text not null default '',
  add column if not exists break_start timestamptz null,
  add column if not exists total_break_mins integer not null default 0;

alter table public.attendance alter column qr_station_id drop not null;
alter table public.attendance alter column qr_verified_at drop not null;
alter table public.attendance drop constraint if exists attendance_checkin_type_check;
alter table public.attendance add constraint attendance_checkin_type_check
  check (checkin_type in ('GPS','Manual','Mobile','Kiosk','QR_GPS'));

alter table public.kiosk_sessions
  add column if not exists employee_name text,
  add column if not exists center_id text,
  add column if not exists status text not null default 'pending',
  add column if not exists token text,
  add column if not exists user_lat double precision,
  add column if not exists user_lng double precision,
  add column if not exists error text,
  add column if not exists selfie_url text,
  add column if not exists updated_at timestamptz not null default now();

alter table public.kiosk_sessions drop constraint if exists kiosk_sessions_status_check;
alter table public.kiosk_sessions add constraint kiosk_sessions_status_check
  check (status in ('pending','camera_ready','uploading','completed','failed'));
alter table public.kiosk_sessions enable row level security;
revoke all on public.kiosk_sessions from anon;
grant select, insert, update on public.kiosk_sessions to authenticated;

create or replace function tms_private.can_manage_employee(p_employee_id text)
returns boolean
language sql
stable security definer
set search_path = ''
as $$
  with actor as (
    select employee_id, role, managed_locations
    from public.employees
    where auth_user_id = auth.uid() and status = 'Active'
    limit 1
  ), target as (
    select employee_id, center_id, direct_manager_id
    from public.employees
    where employee_id = p_employee_id
  )
  select exists (
    select 1 from actor a cross join target t
    where a.role in ('Admin','HR','Director')
       or (
         a.role in ('Manager','Leader')
         and (
           t.direct_manager_id = a.employee_id
           or t.center_id = any(coalesce(a.managed_locations, '{}'::text[]))
         )
       )
  );
$$;
revoke all on function tms_private.can_manage_employee(text) from public, anon;
grant usage on schema tms_private to authenticated;
grant execute on function tms_private.can_manage_employee(text) to authenticated;

create or replace function public.get_employee_directory()
returns table (
  employee_id text, name text, email text, phone text, role text,
  center_id text, position_title text, department text, avatar_url text,
  direct_manager_id text
)
language sql
stable security definer
set search_path = ''
as $$
  with me as (
    select e.employee_id, e.role, e.center_id, e.allowed_locations, e.managed_locations
    from public.employees e
    where e.auth_user_id = auth.uid() and e.status = 'Active'
    limit 1
  )
  select e.employee_id, e.name, e.email, e.phone, e.role, e.center_id,
         e.position, e.department, e.avatar_url, e.direct_manager_id
  from public.employees e
  cross join me
  where e.status = 'Active'
    and e.role <> 'Kiosk'
    and (
      me.role in ('Admin','HR','Director')
      or e.employee_id = me.employee_id
      or e.direct_manager_id = me.employee_id
      or e.center_id = me.center_id
      or e.center_id = any(coalesce(me.allowed_locations, '{}'::text[]))
      or e.center_id = any(coalesce(me.managed_locations, '{}'::text[]))
    )
  order by e.name;
$$;
revoke all on function public.get_employee_directory() from public, anon;
grant execute on function public.get_employee_directory() to authenticated;

create or replace function public.record_mobile_checkin(
  p_lat double precision,
  p_lng double precision,
  p_accuracy double precision,
  p_device_id text,
  p_selfie_url text default '',
  p_checkin_type text default 'Mobile'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  employee_row public.employees%rowtype;
  location_row public.locations%rowtype;
  shift_row public.config_shifts%rowtype;
  attendance_row public.attendance%rowtype;
  now_at timestamptz := clock_timestamp();
  local_date date;
  local_time time;
  local_time_text text;
  distance double precision;
  allowed_radius integer;
  late_tolerance integer;
  late_minutes integer := 0;
begin
  if auth.uid() is null then raise exception 'Vui lòng đăng nhập.'; end if;
  if p_checkin_type not in ('GPS','Mobile') then raise exception 'Hình thức chấm công không hợp lệ.'; end if;
  if p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180 then
    raise exception 'Dữ liệu GPS không hợp lệ.';
  end if;
  if p_accuracy is null or p_accuracy <= 0 or p_accuracy > 200 then
    raise exception 'Độ chính xác GPS chưa đạt yêu cầu (%m).', round(coalesce(p_accuracy, 0));
  end if;
  if p_device_id is null or length(trim(p_device_id)) < 8 then
    raise exception 'Không xác định được thiết bị.';
  end if;

  select * into employee_row
  from public.employees
  where auth_user_id = auth.uid() and status = 'Active';
  if not found then raise exception 'Không tìm thấy hồ sơ nhân viên.'; end if;
  if employee_row.role = 'Kiosk' then raise exception 'Tài khoản Kiosk không được chấm công cá nhân.'; end if;

  select * into location_row
  from public.locations l
  where l.active
    and (
      l.center_id = employee_row.center_id
      or l.center_id = any(coalesce(employee_row.allowed_locations, '{}'::text[]))
    )
  order by tms_private.distance_meters(p_lat, p_lng, l.latitude, l.longitude)
  limit 1;
  if not found then raise exception 'Bạn chưa được gán chi nhánh chấm công hợp lệ.'; end if;

  distance := tms_private.distance_meters(p_lat, p_lng, location_row.latitude, location_row.longitude);
  allowed_radius := greatest(20, least(1000, location_row.radius_meters));
  if distance > allowed_radius then
    raise exception 'Bạn đang cách % %m; bán kính cho phép là %m.', location_row.center_name, round(distance), allowed_radius;
  end if;

  local_date := (now_at at time zone 'Asia/Ho_Chi_Minh')::date;
  local_time := (now_at at time zone 'Asia/Ho_Chi_Minh')::time(0);
  local_time_text := to_char(local_time, 'HH24:MI');
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(employee_row.employee_id || ':' || local_date::text));

  update public.attendance
  set time_out = '23:59', status = 'Invalid', is_valid = 'No',
      note = 'System: Tự đóng phiên quên check-out', break_start = null,
      last_updated = now_at
  where employee_id = employee_row.employee_id
    and attendance_date < local_date
    and time_out = '';

  select * into attendance_row
  from public.attendance
  where employee_id = employee_row.employee_id and attendance_date = local_date
  for update;
  if found then
    if attendance_row.time_out = '' then raise exception 'Bạn chưa Check-out ca làm việc hiện tại.'; end if;
    raise exception 'Bạn đã hoàn tất chấm công hôm nay.';
  end if;

  select * into shift_row
  from public.config_shifts
  where active and local_time <= break_point
  order by sort_order, start_time
  limit 1;
  if not found then
    select * into shift_row from public.config_shifts where active order by sort_order desc, start_time desc limit 1;
  end if;
  if not found then raise exception 'Chưa cấu hình ca làm việc.'; end if;

  late_tolerance := coalesce((select value::integer from public.config_system where key = 'LATE_TOLERANCE'), 15);
  if local_time > shift_row.start_time + make_interval(mins => late_tolerance) then
    late_minutes := greatest(0, (extract(epoch from (local_time - shift_row.start_time)) / 60)::integer);
  end if;

  insert into public.attendance (
    id, attendance_date, employee_id, employee_name, center_id, location_name,
    shift_name, shift_start, shift_end, time_in, time_out, checkin_type,
    checkin_lat, checkin_lng, distance_meters, location_accuracy_m,
    device_id, selfie_url, late_minutes, early_minutes, work_hours,
    status, is_valid, note, checked_in_at, last_updated
  ) values (
    employee_row.employee_id || '_' || local_date::text,
    local_date, employee_row.employee_id, employee_row.name,
    location_row.center_id, location_row.center_name,
    shift_row.name, to_char(shift_row.start_time,'HH24:MI'), to_char(shift_row.end_time,'HH24:MI'),
    local_time_text, '', p_checkin_type,
    p_lat, p_lng, distance, p_accuracy,
    trim(p_device_id), coalesce(p_selfie_url,''), late_minutes, 0, 0,
    case when late_minutes > 0 then 'Late' else 'Valid' end,
    'Yes', '', now_at, now_at
  ) returning * into attendance_row;

  return jsonb_build_object(
    'success', true,
    'action', 'checkin',
    'message', 'Check-in thành công tại ' || location_row.center_name || '! (' || shift_row.name || ')',
    'attendance', tms_private.attendance_json(attendance_row)
  );
end;
$$;
revoke all on function public.record_mobile_checkin(double precision,double precision,double precision,text,text,text) from public, anon;
grant execute on function public.record_mobile_checkin(double precision,double precision,double precision,text,text,text) to authenticated;

create or replace function public.record_mobile_checkout(
  p_lat double precision,
  p_lng double precision,
  p_accuracy double precision
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  employee_row public.employees%rowtype;
  location_row public.locations%rowtype;
  attendance_row public.attendance%rowtype;
  now_at timestamptz := clock_timestamp();
  local_date date;
  local_time time;
  local_time_text text;
  distance double precision;
  allowed_radius integer;
  lunch_start time;
  lunch_end time;
  total_minutes numeric;
  lunch_overlap numeric := 0;
  early_minutes integer := 0;
  net_minutes numeric;
begin
  if auth.uid() is null then raise exception 'Vui lòng đăng nhập.'; end if;
  if p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180 then
    raise exception 'Dữ liệu GPS Check-out không hợp lệ.';
  end if;
  if p_accuracy is null or p_accuracy <= 0 or p_accuracy > 200 then
    raise exception 'Độ chính xác GPS chưa đạt yêu cầu (%m).', round(coalesce(p_accuracy, 0));
  end if;

  select * into employee_row from public.employees where auth_user_id = auth.uid() and status = 'Active';
  if not found then raise exception 'Không tìm thấy hồ sơ nhân viên.'; end if;

  local_date := (now_at at time zone 'Asia/Ho_Chi_Minh')::date;
  local_time := (now_at at time zone 'Asia/Ho_Chi_Minh')::time(0);
  local_time_text := to_char(local_time, 'HH24:MI');
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(employee_row.employee_id || ':' || local_date::text));

  select * into attendance_row
  from public.attendance
  where employee_id = employee_row.employee_id and attendance_date = local_date and time_out = ''
  for update;
  if not found then raise exception 'Không tìm thấy phiên làm việc để Check-out.'; end if;

  select * into location_row from public.locations where center_id = attendance_row.center_id and active;
  if not found then raise exception 'Chi nhánh chấm công không còn cấu hình vị trí.'; end if;

  distance := tms_private.distance_meters(p_lat, p_lng, location_row.latitude, location_row.longitude);
  allowed_radius := greatest(20, least(1000, location_row.radius_meters));
  if distance > allowed_radius then
    raise exception 'Check-out thất bại: bạn đang cách % %m; bán kính cho phép %m.', location_row.center_name, round(distance), allowed_radius;
  end if;

  lunch_start := coalesce((select value::time from public.config_system where key='LUNCH_START'), '12:00'::time);
  lunch_end := coalesce((select value::time from public.config_system where key='LUNCH_END'), '13:30'::time);
  total_minutes := greatest(0, extract(epoch from (local_time - attendance_row.time_in::time)) / 60);
  if local_time > lunch_start and attendance_row.time_in::time < lunch_end then
    lunch_overlap := greatest(0, extract(epoch from (least(local_time,lunch_end) - greatest(attendance_row.time_in::time,lunch_start))) / 60);
  end if;
  if attendance_row.shift_end <> '' and local_time < attendance_row.shift_end::time then
    early_minutes := greatest(0, (extract(epoch from (attendance_row.shift_end::time - local_time)) / 60)::integer);
  end if;
  net_minutes := greatest(0, total_minutes - lunch_overlap - coalesce(attendance_row.total_break_mins,0));

  update public.attendance
  set time_out = local_time_text,
      checkout_lat = p_lat,
      checkout_lng = p_lng,
      checkout_distance = distance,
      checkout_accuracy_m = p_accuracy,
      early_minutes = early_minutes,
      work_hours = round(net_minutes / 60, 2),
      checked_out_at = now_at,
      break_start = null,
      last_updated = now_at
  where id = attendance_row.id
  returning * into attendance_row;

  return jsonb_build_object(
    'success', true,
    'action', 'checkout',
    'message', 'Check-out thành công! Công: ' || to_char(attendance_row.work_hours, 'FM999990.00') || 'h',
    'attendance', tms_private.attendance_json(attendance_row)
  );
end;
$$;
revoke all on function public.record_mobile_checkout(double precision,double precision,double precision) from public, anon;
grant execute on function public.record_mobile_checkout(double precision,double precision,double precision) to authenticated;

create or replace function public.toggle_attendance_pause(p_is_pausing boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  employee_row public.employees%rowtype;
  attendance_row public.attendance%rowtype;
  now_at timestamptz := clock_timestamp();
  local_date date := (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date;
  diff_mins integer;
begin
  if auth.uid() is null then raise exception 'Vui lòng đăng nhập.'; end if;
  select * into employee_row from public.employees where auth_user_id = auth.uid() and status='Active';
  if not found then raise exception 'Không tìm thấy hồ sơ nhân viên.'; end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(employee_row.employee_id || ':' || local_date::text));
  select * into attendance_row from public.attendance
  where employee_id=employee_row.employee_id and attendance_date=local_date and time_out=''
  for update;
  if not found then raise exception 'Không tìm thấy phiên làm việc.'; end if;

  if p_is_pausing then
    if attendance_row.break_start is not null then raise exception 'Bạn đang trong thời gian nghỉ rồi.'; end if;
    update public.attendance set break_start=now_at,last_updated=now_at where id=attendance_row.id returning * into attendance_row;
    return jsonb_build_object('success',true,'message','Đã tạm dừng công việc.','attendance',tms_private.attendance_json(attendance_row));
  end if;

  if attendance_row.break_start is null then raise exception 'Bạn chưa tạm dừng.'; end if;
  diff_mins := greatest(0, floor(extract(epoch from (now_at - attendance_row.break_start))/60)::integer);
  update public.attendance
  set break_start=null,total_break_mins=coalesce(total_break_mins,0)+diff_mins,last_updated=now_at
  where id=attendance_row.id returning * into attendance_row;
  return jsonb_build_object('success',true,'message','Đã tiếp tục làm việc! (Nghỉ '||diff_mins||'p)','attendance',tms_private.attendance_json(attendance_row));
end;
$$;
revoke all on function public.toggle_attendance_pause(boolean) from public, anon;
grant execute on function public.toggle_attendance_pause(boolean) to authenticated;

create or replace function public.submit_leave_request(
  p_type text,
  p_from_date date,
  p_to_date date,
  p_reason text
)
returns public.leave_requests
language plpgsql
security definer
set search_path=''
as $$
declare
  employee_row public.employees%rowtype;
  result_row public.leave_requests%rowtype;
  requested_days integer;
begin
  if auth.uid() is null then raise exception 'Vui lòng đăng nhập.'; end if;
  select * into employee_row from public.employees where auth_user_id=auth.uid() and status='Active';
  if not found then raise exception 'Không tìm thấy hồ sơ nhân viên.'; end if;
  if p_type not in ('Nghỉ phép','Nghỉ ốm','Nghỉ không lương','Công tác','Làm việc tại nhà','WFH') then
    raise exception 'Loại yêu cầu không hợp lệ.';
  end if;
  if p_from_date is null or p_to_date is null or p_to_date < p_from_date then raise exception 'Khoảng ngày không hợp lệ.'; end if;
  if length(trim(coalesce(p_reason,''))) < 2 then raise exception 'Vui lòng nhập lý do.'; end if;
  if exists (
    select 1 from public.leave_requests r
    where r.employee_id=employee_row.employee_id
      and coalesce(r.status,'Pending') <> 'Rejected'
      and daterange(r.from_date,r.to_date,'[]') && daterange(p_from_date,p_to_date,'[]')
  ) then raise exception 'Khoảng thời gian này đã trùng với một yêu cầu khác.'; end if;

  requested_days := (p_to_date - p_from_date) + 1;
  if p_type='Nghỉ phép' and requested_days > employee_row.annual_leave_balance then
    raise exception 'Số ngày nghỉ (% ngày) vượt quá phép còn lại (% ngày).', requested_days, employee_row.annual_leave_balance;
  end if;

  insert into public.leave_requests(employee_id,name,type,from_date,to_date,reason,status)
  values(employee_row.employee_id,employee_row.name,p_type,p_from_date,p_to_date,trim(p_reason),'Pending')
  returning * into result_row;
  return result_row;
end;
$$;
revoke all on function public.submit_leave_request(text,date,date,text) from public, anon;
grant execute on function public.submit_leave_request(text,date,date,text) to authenticated;

create or replace function public.submit_attendance_explanation(
  p_attendance_date date,
  p_reason text
)
returns public.attendance_explanations
language plpgsql
security definer
set search_path=''
as $$
declare
  employee_row public.employees%rowtype;
  result_row public.attendance_explanations%rowtype;
  local_today date := (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date;
  current_month date;
  target_month date;
  existing_count integer;
begin
  if auth.uid() is null then raise exception 'Vui lòng đăng nhập.'; end if;
  select * into employee_row from public.employees where auth_user_id=auth.uid() and status='Active';
  if not found then raise exception 'Không tìm thấy hồ sơ nhân viên.'; end if;
  if p_attendance_date is null or p_attendance_date > local_today then raise exception 'Ngày giải trình không hợp lệ.'; end if;
  if length(trim(coalesce(p_reason,''))) < 2 then raise exception 'Vui lòng nhập nội dung giải trình.'; end if;

  current_month := date_trunc('month',local_today)::date;
  target_month := date_trunc('month',p_attendance_date)::date;
  if not (
    target_month = current_month
    or (target_month = (current_month - interval '1 month')::date and extract(day from local_today) <= 5)
  ) then
    raise exception 'Đã quá thời hạn giải trình. Tháng trước chỉ được giải trình đến hết ngày 05 của tháng này.';
  end if;

  select count(*) into existing_count
  from public.attendance_explanations x
  where x.employee_id=employee_row.employee_id
    and date_trunc('month',x.attendance_date)::date=target_month
    and x.status <> 'Rejected';
  if existing_count >= 5 then raise exception 'Bạn đã đạt giới hạn 5 giải trình trong tháng này.'; end if;

  insert into public.attendance_explanations(employee_id,attendance_date,reason,status)
  values(employee_row.employee_id,p_attendance_date,trim(p_reason),'Pending')
  returning * into result_row;
  return result_row;
end;
$$;
revoke all on function public.submit_attendance_explanation(date,text) from public, anon;
grant execute on function public.submit_attendance_explanation(date,text) to authenticated;

create or replace function public.update_my_avatar(p_avatar_url text)
returns void
language plpgsql
security definer
set search_path=''
as $$
declare v_employee_id text;
begin
  if auth.uid() is null then raise exception 'Vui lòng đăng nhập.'; end if;
  select employee_id into v_employee_id from public.employees where auth_user_id=auth.uid() and status='Active';
  if not found then raise exception 'Không tìm thấy hồ sơ nhân viên.'; end if;
  if p_avatar_url is null or length(trim(p_avatar_url)) < 4 or length(p_avatar_url) > 4000 then
    raise exception 'Đường dẫn ảnh không hợp lệ.';
  end if;
  update public.employees
  set avatar_url=trim(p_avatar_url), face_ref_url=trim(p_avatar_url), updated_at=now()
  where employee_id=v_employee_id;
end;
$$;
revoke all on function public.update_my_avatar(text) from public, anon;
grant execute on function public.update_my_avatar(text) to authenticated;

create or replace function public.record_kiosk_checkin(
  p_employee_id text,
  p_kiosk_id text,
  p_lat double precision,
  p_lng double precision,
  p_accuracy double precision,
  p_selfie_url text default ''
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  actor public.employees%rowtype;
  employee_row public.employees%rowtype;
  kiosk_row public.kiosks%rowtype;
  location_row public.locations%rowtype;
  shift_row public.config_shifts%rowtype;
  session_row public.kiosk_sessions%rowtype;
  attendance_row public.attendance%rowtype;
  now_at timestamptz := clock_timestamp();
  local_date date;
  local_time time;
  local_time_text text;
  kiosk_distance double precision;
  employee_distance double precision;
  allowed_radius integer;
  late_tolerance integer;
  late_minutes integer := 0;
begin
  if auth.uid() is null then raise exception 'Vui lòng đăng nhập.'; end if;
  select * into actor from public.employees where auth_user_id=auth.uid() and status='Active';
  if not found or actor.role not in ('Kiosk','Admin','Director','HR') then raise exception 'Tài khoản không có quyền vận hành Kiosk.'; end if;

  select * into kiosk_row from public.kiosks where kiosk_id=p_kiosk_id and status='Active';
  if not found then raise exception 'Kiosk chưa được cấu hình hoặc đã vô hiệu hóa.'; end if;
  if actor.role='Kiosk' and kiosk_row.center_id <> actor.center_id and not (kiosk_row.center_id=any(coalesce(actor.allowed_locations,'{}'::text[]))) then
    raise exception 'Kiosk không thuộc cơ sở được gán cho tài khoản này.';
  end if;

  select * into employee_row from public.employees where employee_id=p_employee_id and status='Active';
  if not found or employee_row.role='Kiosk' then raise exception 'Nhân viên chấm công không hợp lệ.'; end if;
  if kiosk_row.center_id <> employee_row.center_id and not (kiosk_row.center_id=any(coalesce(employee_row.allowed_locations,'{}'::text[]))) then
    raise exception 'Nhân viên không được chấm công tại cơ sở này.';
  end if;

  select * into session_row
  from public.kiosk_sessions
  where kiosk_id=p_kiosk_id and employee_id=p_employee_id and status='camera_ready'
    and created_at >= now_at - interval '90 seconds'
  order by created_at desc
  limit 1
  for update;
  if not found then raise exception 'Phiên Kiosk không còn hợp lệ. Vui lòng quét lại QR.'; end if;

  select * into location_row from public.locations where center_id=kiosk_row.center_id and active;
  if not found then raise exception 'Cơ sở chưa cấu hình vị trí.'; end if;
  if p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180 then raise exception 'GPS Kiosk không hợp lệ.'; end if;
  if p_accuracy is null or p_accuracy <= 0 or p_accuracy > 200 then raise exception 'Độ chính xác GPS Kiosk chưa đạt yêu cầu.'; end if;

  allowed_radius := greatest(20,least(1000,location_row.radius_meters));
  kiosk_distance := tms_private.distance_meters(p_lat,p_lng,location_row.latitude,location_row.longitude);
  if kiosk_distance > allowed_radius then raise exception 'Kiosk đang nằm ngoài bán kính cơ sở (%m).',round(kiosk_distance); end if;

  if session_row.user_lat is null or session_row.user_lng is null then raise exception 'Phiên chấm công thiếu GPS nhân viên.'; end if;
  employee_distance := tms_private.distance_meters(session_row.user_lat,session_row.user_lng,location_row.latitude,location_row.longitude);
  if employee_distance > allowed_radius then raise exception 'Vị trí nhân viên nằm ngoài bán kính cơ sở (%m).',round(employee_distance); end if;

  local_date := (now_at at time zone 'Asia/Ho_Chi_Minh')::date;
  local_time := (now_at at time zone 'Asia/Ho_Chi_Minh')::time(0);
  local_time_text := to_char(local_time,'HH24:MI');
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(employee_row.employee_id || ':' || local_date::text));

  update public.attendance
  set time_out='23:59',status='Invalid',is_valid='No',note='System: Tự đóng phiên quên check-out',break_start=null,last_updated=now_at
  where employee_id=employee_row.employee_id and attendance_date<local_date and time_out='';

  select * into attendance_row from public.attendance where employee_id=employee_row.employee_id and attendance_date=local_date for update;
  if found then
    if attendance_row.time_out='' then raise exception 'Nhân viên chưa Check-out ca làm việc hiện tại.'; end if;
    raise exception 'Nhân viên đã hoàn tất chấm công hôm nay.';
  end if;

  select * into shift_row from public.config_shifts where active and local_time<=break_point order by sort_order,start_time limit 1;
  if not found then select * into shift_row from public.config_shifts where active order by sort_order desc,start_time desc limit 1; end if;
  if not found then raise exception 'Chưa cấu hình ca làm việc.'; end if;

  late_tolerance := coalesce((select value::integer from public.config_system where key='LATE_TOLERANCE'),15);
  if local_time > shift_row.start_time + make_interval(mins=>late_tolerance) then
    late_minutes := greatest(0,(extract(epoch from (local_time-shift_row.start_time))/60)::integer);
  end if;

  insert into public.attendance(
    id,attendance_date,employee_id,employee_name,center_id,location_name,
    shift_name,shift_start,shift_end,time_in,time_out,checkin_type,
    checkin_lat,checkin_lng,distance_meters,location_accuracy_m,device_id,selfie_url,
    late_minutes,early_minutes,work_hours,status,is_valid,note,checked_in_at,last_updated
  ) values (
    employee_row.employee_id||'_'||local_date::text,local_date,employee_row.employee_id,employee_row.name,
    location_row.center_id,location_row.center_name,shift_row.name,to_char(shift_row.start_time,'HH24:MI'),to_char(shift_row.end_time,'HH24:MI'),
    local_time_text,'','Kiosk',p_lat,p_lng,kiosk_distance,p_accuracy,p_kiosk_id,coalesce(p_selfie_url,''),
    late_minutes,0,0,case when late_minutes>0 then 'Late' else 'Valid' end,'Yes','',now_at,now_at
  ) returning * into attendance_row;

  update public.kiosk_sessions set status='completed',selfie_url=coalesce(p_selfie_url,''),updated_at=now_at where session_id=session_row.session_id;

  return jsonb_build_object('success',true,'action','checkin','message','Check-in Kiosk thành công tại '||location_row.center_name||'!','attendance',tms_private.attendance_json(attendance_row));
end;
$$;
revoke all on function public.record_kiosk_checkin(text,text,double precision,double precision,double precision,text) from public, anon;
grant execute on function public.record_kiosk_checkin(text,text,double precision,double precision,double precision,text) to authenticated;

revoke insert on public.leave_requests, public.attendance_explanations from authenticated;

grant select on public.monthly_stats to authenticated;
drop policy if exists monthly_stats_select_scope on public.monthly_stats;
create policy monthly_stats_select_scope on public.monthly_stats
for select to authenticated
using (
  employee_id = (select tms_private.current_employee_id())
  or (select tms_private.can_manage_employee(employee_id))
);

drop policy if exists kiosk_sessions_select on public.kiosk_sessions;
create policy kiosk_sessions_select on public.kiosk_sessions
for select to authenticated
using (
  kiosk_sessions.employee_id = (select tms_private.current_employee_id())
  or exists (
    select 1 from public.employees me
    where me.auth_user_id = (select auth.uid()) and me.status='Active'
      and me.role in ('Kiosk','Admin','Director','HR')
      and (
        me.role in ('Admin','Director','HR')
        or kiosk_sessions.center_id = me.center_id
        or kiosk_sessions.center_id = any(coalesce(me.allowed_locations,'{}'::text[]))
      )
  )
);

drop policy if exists kiosk_sessions_insert on public.kiosk_sessions;
create policy kiosk_sessions_insert on public.kiosk_sessions
for insert to authenticated
with check (
  (
    kiosk_sessions.employee_id = (select tms_private.current_employee_id())
    and kiosk_sessions.status='pending'
    and exists (
      select 1 from public.kiosks k
      where k.kiosk_id=kiosk_sessions.kiosk_id and k.status='Active' and k.center_id=kiosk_sessions.center_id
    )
  )
  or exists (
    select 1 from public.employees me
    where me.auth_user_id=(select auth.uid()) and me.status='Active'
      and me.role in ('Kiosk','Admin','Director','HR')
      and (
        me.role in ('Admin','Director','HR')
        or kiosk_sessions.center_id=me.center_id
        or kiosk_sessions.center_id=any(coalesce(me.allowed_locations,'{}'::text[]))
      )
  )
);

drop policy if exists kiosk_sessions_update on public.kiosk_sessions;
create policy kiosk_sessions_update on public.kiosk_sessions
for update to authenticated
using (
  exists (
    select 1 from public.employees me
    where me.auth_user_id=(select auth.uid()) and me.status='Active'
      and me.role in ('Kiosk','Admin','Director','HR')
      and (
        me.role in ('Admin','Director','HR')
        or kiosk_sessions.center_id=me.center_id
        or kiosk_sessions.center_id=any(coalesce(me.allowed_locations,'{}'::text[]))
      )
  )
)
with check (
  exists (
    select 1 from public.employees me
    where me.auth_user_id=(select auth.uid()) and me.status='Active'
      and me.role in ('Kiosk','Admin','Director','HR')
      and (
        me.role in ('Admin','Director','HR')
        or kiosk_sessions.center_id=me.center_id
        or kiosk_sessions.center_id=any(coalesce(me.allowed_locations,'{}'::text[]))
      )
  )
);

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname='supabase_realtime' and schemaname='public' and tablename='kiosk_sessions'
  ) then
    alter publication supabase_realtime add table public.kiosk_sessions;
  end if;
end $$;

commit;
