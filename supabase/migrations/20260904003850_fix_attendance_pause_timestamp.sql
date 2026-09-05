do $$
-- Production migration version: 20260904003850.
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'attendance'
      and column_name = 'break_start'
      and data_type = 'text'
  ) then
    execute $migration$
      alter table public.attendance
      alter column break_start type timestamptz
      using case
        when break_start is null or btrim(break_start) = '' then null
        else (attendance_date + break_start::time) at time zone 'Asia/Ho_Chi_Minh'
      end
    $migration$;
  end if;
end;
$$;

create or replace function public.toggle_attendance_pause()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  employee_row public.employees%rowtype;
  attendance_row public.attendance%rowtype;
  now_at timestamptz := clock_timestamp();
  local_date date := (now_at at time zone 'Asia/Ho_Chi_Minh')::date;
  elapsed integer;
begin
  if auth.uid() is null then raise exception 'Vui lòng đăng nhập.'; end if;

  select * into employee_row
  from public.employees
  where auth_user_id = auth.uid() and status = 'Active';
  if not found then raise exception 'Không tìm thấy hồ sơ nhân viên.'; end if;

  select * into attendance_row
  from public.attendance
  where employee_id = employee_row.employee_id and attendance_date = local_date
  for update;
  if not found then raise exception 'Bạn chưa check-in hôm nay.'; end if;
  if coalesce(attendance_row.time_out, '') <> '' then raise exception 'Ngày công hôm nay đã hoàn tất.'; end if;

  if attendance_row.break_started_at is null then
    update public.attendance
    set break_started_at = now_at,
        break_start = now_at,
        last_updated = now_at
    where id = attendance_row.id
    returning * into attendance_row;
    return jsonb_build_object('action', 'pause', 'message', 'Đã bắt đầu tạm dừng.', 'attendance', tms_private.attendance_json(attendance_row));
  end if;

  elapsed := greatest(0, floor(extract(epoch from (now_at - attendance_row.break_started_at)) / 60)::integer);
  update public.attendance
  set total_break_mins = coalesce(total_break_mins, 0) + elapsed,
      break_started_at = null,
      break_start = null,
      last_updated = now_at
  where id = attendance_row.id
  returning * into attendance_row;

  return jsonb_build_object('action', 'continue', 'message', 'Đã tiếp tục làm việc.', 'attendance', tms_private.attendance_json(attendance_row));
end;
$$;

revoke all on function public.toggle_attendance_pause() from public, anon;
grant execute on function public.toggle_attendance_pause() to authenticated;
