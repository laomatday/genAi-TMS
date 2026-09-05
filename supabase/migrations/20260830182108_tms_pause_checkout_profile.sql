alter table public.attendance add column if not exists break_start timestamptz;
alter table public.attendance add column if not exists break_started_at timestamptz;
alter table public.attendance add column if not exists total_break_mins integer not null default 0;

create or replace function public.toggle_attendance_pause()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  e public.employees%rowtype;
  a public.attendance%rowtype;
  now_at timestamptz := clock_timestamp();
  local_date date := (now_at at time zone 'Asia/Ho_Chi_Minh')::date;
  elapsed integer;
begin
  if auth.uid() is null then raise exception 'Vui lòng đăng nhập.'; end if;
  select * into e from public.employees where auth_user_id = auth.uid() and status = 'Active';
  if not found then raise exception 'Không tìm thấy hồ sơ nhân viên.'; end if;
  select * into a from public.attendance where employee_id=e.employee_id and attendance_date=local_date for update;
  if not found then raise exception 'Bạn chưa check-in hôm nay.'; end if;
  if coalesce(a.time_out,'') <> '' then raise exception 'Ngày công hôm nay đã hoàn tất.'; end if;

  if a.break_started_at is null then
    update public.attendance
      set break_started_at=now_at,
          break_start=now_at,
          last_updated=now_at
      where id=a.id returning * into a;
    return jsonb_build_object('action','pause','message','Đã bắt đầu tạm dừng.','attendance',tms_private.attendance_json(a));
  end if;

  elapsed := greatest(0, floor(extract(epoch from (now_at-a.break_started_at))/60)::integer);
  update public.attendance
    set total_break_mins=coalesce(total_break_mins,0)+elapsed,
        break_started_at=null,
        break_start=null,
        last_updated=now_at
    where id=a.id returning * into a;
  return jsonb_build_object('action','continue','message','Đã tiếp tục làm việc.','attendance',tms_private.attendance_json(a));
end;
$$;
revoke all on function public.toggle_attendance_pause() from public, anon;
grant execute on function public.toggle_attendance_pause() to authenticated;

create or replace function public.checkout_attendance_gps(
  p_lat double precision,
  p_lng double precision,
  p_accuracy double precision
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  e public.employees%rowtype;
  a public.attendance%rowtype;
  l public.locations%rowtype;
  s public.config_shifts%rowtype;
  now_at timestamptz := clock_timestamp();
  local_date date := (now_at at time zone 'Asia/Ho_Chi_Minh')::date;
  local_time time := (now_at at time zone 'Asia/Ho_Chi_Minh')::time;
  local_text text := to_char(now_at at time zone 'Asia/Ho_Chi_Minh','HH24:MI');
  dist double precision;
  allowed_radius integer;
  total_minutes numeric;
  lunch_start time := '12:00';
  lunch_end time := '13:30';
  lunch_overlap numeric := 0;
  current_break integer := 0;
  early_mins integer := 0;
begin
  if auth.uid() is null then raise exception 'Vui lòng đăng nhập.'; end if;
  if p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180 then raise exception 'Dữ liệu định vị không hợp lệ.'; end if;
  if p_accuracy is null or p_accuracy <= 0 or p_accuracy > 150 then raise exception 'Độ chính xác GPS chưa đạt yêu cầu (%m).', round(coalesce(p_accuracy,0)); end if;

  select * into e from public.employees where auth_user_id=auth.uid() and status='Active';
  if not found then raise exception 'Không tìm thấy hồ sơ nhân viên.'; end if;
  select * into a from public.attendance where employee_id=e.employee_id and attendance_date=local_date for update;
  if not found then raise exception 'Bạn chưa check-in hôm nay.'; end if;
  if coalesce(a.time_out,'') <> '' then raise exception 'Bạn đã check-out hôm nay.'; end if;
  select * into l from public.locations where center_id=a.center_id and active;
  if not found then raise exception 'Địa điểm chấm công không còn hoạt động.'; end if;
  dist := tms_private.distance_meters(p_lat,p_lng,l.latitude,l.longitude);
  begin select value::integer into allowed_radius from public.config_system where key='MAX_DISTANCE_METERS'; exception when others then allowed_radius:=l.radius_meters; end;
  allowed_radius := least(coalesce(allowed_radius,l.radius_meters), l.radius_meters);
  if dist > allowed_radius then raise exception 'Bạn đang cách địa điểm chấm công %m, vượt bán kính %m.', round(dist), allowed_radius; end if;

  if a.break_started_at is not null then current_break := greatest(0,floor(extract(epoch from(now_at-a.break_started_at))/60)::integer); end if;
  begin select value::time into lunch_start from public.config_system where key='LUNCH_START'; exception when others then null; end;
  begin select value::time into lunch_end from public.config_system where key='LUNCH_END'; exception when others then null; end;

  total_minutes := greatest(0, extract(epoch from (now_at-a.checked_in_at))/60);
  if lunch_end > lunch_start then
    lunch_overlap := greatest(0, extract(epoch from (least(local_time,lunch_end)-greatest((a.checked_in_at at time zone 'Asia/Ho_Chi_Minh')::time,lunch_start)))/60);
  end if;
  total_minutes := greatest(0,total_minutes-lunch_overlap-coalesce(a.total_break_mins,0)-current_break);

  select * into s from public.config_shifts where name=a.shift_name limit 1;
  if found and local_time < s.end_time then early_mins := greatest(0,floor(extract(epoch from(s.end_time-local_time))/60)::integer); end if;

  update public.attendance set
    time_out=local_text,
    checked_out_at=now_at,
    checkout_lat=p_lat,
    checkout_lng=p_lng,
    checkout_distance=dist,
    checkout_accuracy_m=p_accuracy,
    work_hours=round((total_minutes/60)::numeric,2),
    early_minutes=early_mins,
    total_break_mins=coalesce(total_break_mins,0)+current_break,
    break_started_at=null,
    break_start=null,
    last_updated=now_at
  where id=a.id returning * into a;

  return jsonb_build_object('action','checkout','message','Check-out thành công.','attendance',tms_private.attendance_json(a));
end;
$$;
revoke all on function public.checkout_attendance_gps(double precision,double precision,double precision) from public, anon;
grant execute on function public.checkout_attendance_gps(double precision,double precision,double precision) to authenticated;

create or replace function public.set_my_avatar(p_url text)
returns void
language plpgsql
security definer
set search_path=''
as $$
begin
  if auth.uid() is null then raise exception 'Vui lòng đăng nhập.'; end if;
  if p_url is null or length(p_url)>2000000 then raise exception 'Ảnh đại diện không hợp lệ.'; end if;
  update public.employees set avatar_url=p_url, face_ref_url=p_url, updated_at=clock_timestamp() where auth_user_id=auth.uid();
  if not found then raise exception 'Không tìm thấy hồ sơ nhân viên.'; end if;
end;
$$;
revoke all on function public.set_my_avatar(text) from public, anon;
grant execute on function public.set_my_avatar(text) to authenticated;
