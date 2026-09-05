insert into public.config_system (key, value)
values ('MAX_EXPLANATIONS_PER_MONTH', '5')
on conflict (key) do nothing;

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
  max_explanations integer := 5;
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

  select least(100, greatest(1, value::integer)) into max_explanations
  from public.config_system
  where key in ('MAX_EXPLANATIONS_PER_MONTH', 'MAX_EXPLANATION_PER_MONTH') and value ~ '^[0-9]+$';
  max_explanations := coalesce(max_explanations, 5);

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
  if existing_count >= max_explanations then
    raise exception 'Bạn đã đạt giới hạn % giải trình trong tháng này.', max_explanations;
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
