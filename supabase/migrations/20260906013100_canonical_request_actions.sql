begin;

create or replace function public.delete_attendance_request_v3(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  employee_row public.employees%rowtype;
  request_row public.attendance_requests%rowtype;
  timesheet_row public.timesheets%rowtype;
begin
  if (select auth.uid()) is null then raise exception 'Vui lòng đăng nhập.'; end if;
  select * into employee_row
  from public.employees
  where auth_user_id = (select auth.uid()) and status = 'Active';
  if not found then raise exception 'Không tìm thấy hồ sơ nhân viên.'; end if;

  select * into request_row
  from public.attendance_requests
  where id = p_id and employee_id = employee_row.employee_id
  for update;
  if not found then
    return jsonb_build_object('success', false, 'message', 'Không tìm thấy giải trình.');
  end if;
  if request_row.status <> 'PENDING' then
    return jsonb_build_object('success', false, 'message', 'Giải trình đã được xử lý và không thể xoá.');
  end if;

  select * into timesheet_row from public.timesheets where id = request_row.timesheet_id for update;
  delete from public.attendance_requests where id = request_row.id;

  if timesheet_row.id is not null and timesheet_row.status = 'PENDING_REVIEW' then
    update public.timesheets
    set status = case
      when coalesce(array_length(timesheet_row.exception_codes, 1), 0) > 0 then 'EXCEPTION'
      when timesheet_row.actual_checkout is not null then 'COMPLETE'
      else 'OPEN'
    end,
    updated_at = clock_timestamp()
    where id = timesheet_row.id;
  end if;

  insert into public.audit_logs(
    actor_employee_id, target_employee_id, action, entity_type, entity_id, reason, metadata
  ) values (
    employee_row.employee_id, employee_row.employee_id,
    'ATTENDANCE_REQUEST_DELETED', 'attendance_request', request_row.id::text,
    'Người dùng xoá yêu cầu đang chờ duyệt',
    jsonb_build_object('timesheet_id', request_row.timesheet_id, 'request_type', request_row.request_type)
  );

  return jsonb_build_object('success', true);
end;
$$;

revoke all on function public.delete_attendance_request_v3(uuid) from public, anon;
grant execute on function public.delete_attendance_request_v3(uuid) to authenticated;

commit;
