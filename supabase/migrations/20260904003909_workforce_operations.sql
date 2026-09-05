-- Workforce operations: employee shift assignments, atomic attendance review,
-- and auditable monthly attendance closing.
-- Production migration version: 20260904003909.

create table public.shift_assignments (
  id uuid primary key default extensions.gen_random_uuid(),
  employee_id text not null references public.employees(employee_id) on update cascade on delete cascade,
  work_date date not null,
  shift_id bigint not null references public.config_shifts(id) on update cascade on delete restrict,
  location_id text references public.locations(center_id) on update cascade on delete set null,
  note text not null default '' check (char_length(note) <= 500),
  created_by text references public.employees(employee_id) on update cascade on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (employee_id, work_date)
);

create index shift_assignments_work_date_employee_idx
  on public.shift_assignments(work_date, employee_id);
create index shift_assignments_shift_id_idx
  on public.shift_assignments(shift_id);
create index shift_assignments_location_date_idx
  on public.shift_assignments(location_id, work_date);
create index shift_assignments_created_by_idx
  on public.shift_assignments(created_by);

create table public.attendance_periods (
  id uuid primary key default extensions.gen_random_uuid(),
  period_start date not null,
  period_end date not null,
  status text not null default 'CLOSED' check (status in ('CLOSED', 'REOPENED')),
  closed_by text not null references public.employees(employee_id) on update cascade on delete restrict,
  closed_at timestamptz not null default now(),
  note text not null default '' check (char_length(note) <= 1000),
  reopened_by text references public.employees(employee_id) on update cascade on delete set null,
  reopened_at timestamptz,
  reopen_reason text check (reopen_reason is null or char_length(reopen_reason) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (period_start <= period_end),
  unique (period_start, period_end)
);

create index attendance_periods_status_period_idx
  on public.attendance_periods(status, period_start desc);
create index attendance_periods_closed_by_idx
  on public.attendance_periods(closed_by);
create index attendance_periods_reopened_by_idx
  on public.attendance_periods(reopened_by);

alter table public.shift_assignments enable row level security;
alter table public.attendance_periods enable row level security;

create policy shift_assignments_read_scope
  on public.shift_assignments for select to authenticated
  using (
    employee_id = (select tms_private.current_employee_id())
    or (select tms_private.can_manage_employee(employee_id))
  );

create policy attendance_periods_admin_read
  on public.attendance_periods for select to authenticated
  using ((select tms_private.is_admin_operator()));

revoke all on table public.shift_assignments, public.attendance_periods
  from public, anon, authenticated;
grant select on table public.shift_assignments, public.attendance_periods
  to authenticated;

create or replace function tms_private.apply_assigned_shift_to_timesheet()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  assignment_row public.shift_assignments%rowtype;
  shift_row public.config_shifts%rowtype;
begin
  select assignment.* into assignment_row
  from public.shift_assignments assignment
  where assignment.employee_id = new.employee_id
    and assignment.work_date = new.work_date;

  if found then
    select * into shift_row from public.config_shifts where id = assignment_row.shift_id;
    new.expected_start := ((new.work_date + shift_row.start_time) at time zone 'Asia/Ho_Chi_Minh');
    new.expected_end := (
      (new.work_date + shift_row.end_time
        + case when shift_row.end_time <= shift_row.start_time then interval '1 day' else interval '0 day' end)
      at time zone 'Asia/Ho_Chi_Minh'
    );
    new.location_id := coalesce(assignment_row.location_id, new.location_id);
  end if;
  return new;
end;
$$;

revoke all on function tms_private.apply_assigned_shift_to_timesheet() from public, anon, authenticated;

drop trigger if exists timesheets_apply_assigned_shift on public.timesheets;
create trigger timesheets_apply_assigned_shift
before insert or update of expected_start, expected_end, location_id on public.timesheets
for each row execute function tms_private.apply_assigned_shift_to_timesheet();

create or replace function public.save_shift_assignments_v1(p_assignments jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor public.employees%rowtype;
  item jsonb;
  employee_row public.employees%rowtype;
  shift_row public.config_shifts%rowtype;
  target_date date;
  target_location text;
  target_note text;
  expected_start_at timestamptz;
  expected_end_at timestamptz;
  saved_count integer := 0;
  target_ids text[] := '{}'::text[];
begin
  select * into actor
  from public.employees
  where auth_user_id = (select auth.uid()) and status = 'Active';
  if not found or actor.role not in ('Admin', 'HR', 'Director') then
    raise exception 'Bạn không có quyền phân ca.';
  end if;
  if jsonb_typeof(p_assignments) <> 'array'
    or jsonb_array_length(p_assignments) < 1
    or jsonb_array_length(p_assignments) > 500 then
    raise exception 'Danh sách phân ca phải có từ 1 đến 500 nhân viên.';
  end if;

  for item in select value from jsonb_array_elements(p_assignments)
  loop
    target_date := nullif(item->>'work_date', '')::date;
    if target_date is null or target_date < (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date then
      raise exception 'Chỉ được phân ca cho hôm nay hoặc tương lai.';
    end if;
    if exists (
      select 1 from public.attendance_periods period
      where period.status = 'CLOSED' and target_date between period.period_start and period.period_end
    ) then
      raise exception 'Ngày % thuộc kỳ công đã đóng.', target_date;
    end if;

    select * into employee_row
    from public.employees
    where employee_id = nullif(trim(item->>'employee_id'), '')
      and status = 'Active' and role <> 'Kiosk';
    if not found then raise exception 'Nhân viên phân ca không hợp lệ.'; end if;
    if not (select tms_private.can_manage_employee(employee_row.employee_id)) then
      raise exception 'Bạn không được phân ca cho nhân viên %.', employee_row.employee_id;
    end if;

    select * into shift_row
    from public.config_shifts
    where id = nullif(item->>'shift_id', '')::bigint and active;
    if not found then raise exception 'Ca làm không hợp lệ.'; end if;

    target_location := coalesce(nullif(trim(item->>'location_id'), ''), employee_row.center_id);
    if not exists (select 1 from public.locations where center_id = target_location and active) then
      raise exception 'Địa điểm phân ca không hợp lệ.';
    end if;
    target_note := left(coalesce(trim(item->>'note'), ''), 500);

    if exists (
      select 1 from public.timesheets timesheet
      where timesheet.employee_id = employee_row.employee_id
        and timesheet.work_date = target_date
        and (timesheet.actual_checkin is not null or timesheet.status = 'LOCKED')
    ) then
      raise exception 'Ngày công của % vào % đã phát sinh và không thể đổi ca.', employee_row.employee_id, target_date;
    end if;

    insert into public.shift_assignments(
      employee_id, work_date, shift_id, location_id, note, created_by, updated_at
    ) values (
      employee_row.employee_id, target_date, shift_row.id, target_location,
      target_note, actor.employee_id, clock_timestamp()
    )
    on conflict(employee_id, work_date) do update
    set shift_id = excluded.shift_id,
        location_id = excluded.location_id,
        note = excluded.note,
        created_by = excluded.created_by,
        updated_at = clock_timestamp();

    expected_start_at := ((target_date + shift_row.start_time) at time zone 'Asia/Ho_Chi_Minh');
    expected_end_at := (
      (target_date + shift_row.end_time
        + case when shift_row.end_time <= shift_row.start_time then interval '1 day' else interval '0 day' end)
      at time zone 'Asia/Ho_Chi_Minh'
    );
    insert into public.timesheets(
      employee_id, work_date, policy_id, location_id,
      expected_start, expected_end, status, exception_codes, updated_at
    ) values (
      employee_row.employee_id, target_date, employee_row.attendance_policy_id, target_location,
      expected_start_at, expected_end_at, 'OPEN', '{}'::text[], clock_timestamp()
    )
    on conflict(employee_id, work_date) do update
    set policy_id = excluded.policy_id,
        location_id = excluded.location_id,
        expected_start = excluded.expected_start,
        expected_end = excluded.expected_end,
        updated_at = clock_timestamp()
    where timesheets.actual_checkin is null
      and timesheets.status not in ('LOCKED', 'PENDING_REVIEW', 'APPROVED');

    saved_count := saved_count + 1;
    target_ids := array_append(target_ids, employee_row.employee_id);
  end loop;

  insert into public.audit_logs(
    actor_employee_id, action, entity_type, reason, metadata
  ) values (
    actor.employee_id, 'SHIFT_ASSIGNMENTS_SAVED', 'shift_assignment', 'Phân ca hàng loạt',
    jsonb_build_object('count', saved_count, 'employee_ids', target_ids)
  );
  return saved_count;
end;
$$;

create or replace function public.delete_shift_assignment_v1(p_id uuid, p_reason text default '')
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor public.employees%rowtype;
  assignment_row public.shift_assignments%rowtype;
  policy_row public.attendance_policies%rowtype;
begin
  select * into actor from public.employees
  where auth_user_id = (select auth.uid()) and status = 'Active';
  if not found or actor.role not in ('Admin', 'HR', 'Director') then
    raise exception 'Bạn không có quyền xóa phân ca.';
  end if;
  select * into assignment_row from public.shift_assignments where id = p_id for update;
  if not found then raise exception 'Không tìm thấy lịch phân ca.'; end if;
  if not (select tms_private.can_manage_employee(assignment_row.employee_id)) then
    raise exception 'Bạn không được thay đổi lịch này.';
  end if;
  if assignment_row.work_date < (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date then
    raise exception 'Không thể xóa lịch trong quá khứ.';
  end if;
  if exists (
    select 1 from public.timesheets timesheet
    where timesheet.employee_id = assignment_row.employee_id
      and timesheet.work_date = assignment_row.work_date
      and (timesheet.actual_checkin is not null or timesheet.status = 'LOCKED')
  ) then
    raise exception 'Ngày công đã phát sinh và không thể xóa ca.';
  end if;

  delete from public.shift_assignments where id = assignment_row.id;
  select policy.* into policy_row
  from public.employees employee
  join public.attendance_policies policy on policy.id = employee.attendance_policy_id
  where employee.employee_id = assignment_row.employee_id;
  if found then
    update public.timesheets
    set expected_start = ((assignment_row.work_date + policy_row.expected_start) at time zone 'Asia/Ho_Chi_Minh'),
        expected_end = ((assignment_row.work_date + policy_row.expected_end) at time zone 'Asia/Ho_Chi_Minh'),
        location_id = (select center_id from public.employees where employee_id = assignment_row.employee_id),
        updated_at = clock_timestamp()
    where employee_id = assignment_row.employee_id
      and work_date = assignment_row.work_date
      and actual_checkin is null and status <> 'LOCKED';
  end if;
  insert into public.audit_logs(
    actor_employee_id, target_employee_id, action, entity_type, entity_id, reason, metadata
  ) values (
    actor.employee_id, assignment_row.employee_id, 'SHIFT_ASSIGNMENT_DELETED',
    'shift_assignment', assignment_row.id::text, left(coalesce(trim(p_reason), ''), 1000),
    jsonb_build_object('work_date', assignment_row.work_date, 'shift_id', assignment_row.shift_id)
  );
end;
$$;

create or replace function public.review_attendance_requests_bulk_v1(
  p_requests jsonb,
  p_status text,
  p_note text default ''
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  item jsonb;
  reviewed_count integer := 0;
begin
  if p_status not in ('APPROVED', 'REJECTED') then raise exception 'Trạng thái không hợp lệ.'; end if;
  if jsonb_typeof(p_requests) <> 'array'
    or jsonb_array_length(p_requests) < 1
    or jsonb_array_length(p_requests) > 100 then
    raise exception 'Mỗi lần chỉ xử lý từ 1 đến 100 yêu cầu.';
  end if;
  for item in select value from jsonb_array_elements(p_requests)
  loop
    if item->>'origin' = 'legacy' then
      perform public.review_attendance_explanation(
        (item->>'id')::uuid,
        case when p_status = 'APPROVED' then 'Approved' else 'Rejected' end,
        p_note
      );
    else
      perform public.review_attendance_request_v2((item->>'id')::uuid, p_status, p_note);
    end if;
    reviewed_count := reviewed_count + 1;
  end loop;
  return reviewed_count;
end;
$$;

create or replace function public.close_attendance_period_v1(
  p_from date,
  p_to date,
  p_note text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor public.employees%rowtype;
  unresolved_count integer;
  locked_count integer;
  period_row public.attendance_periods%rowtype;
begin
  select * into actor from public.employees
  where auth_user_id = (select auth.uid()) and status = 'Active';
  if not found or actor.role not in ('Admin', 'HR', 'Director') then
    raise exception 'Bạn không có quyền đóng kỳ công.';
  end if;
  if p_from is null or p_to is null or p_from > p_to
    or p_from <> date_trunc('month', p_from)::date
    or p_to <> (date_trunc('month', p_from) + interval '1 month - 1 day')::date then
    raise exception 'Kỳ công phải bao trọn một tháng dương lịch.';
  end if;
  if p_to >= (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date then
    raise exception 'Chỉ được đóng kỳ công đã kết thúc.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('attendance-period:' || p_from::text));
  if exists (
    select 1 from public.attendance_periods
    where period_start = p_from and period_end = p_to and status = 'CLOSED'
  ) then raise exception 'Kỳ công này đã được đóng.'; end if;

  select count(*) into unresolved_count
  from public.timesheets
  where work_date between p_from and p_to
    and status in ('OPEN', 'EXCEPTION', 'PENDING_REVIEW', 'REJECTED');
  if unresolved_count > 0 then
    raise exception 'Còn % ngày công chưa xử lý; chưa thể đóng kỳ.', unresolved_count;
  end if;

  update public.timesheets
  set status = 'LOCKED', locked_at = clock_timestamp(), locked_by = actor.employee_id,
      updated_at = clock_timestamp()
  where work_date between p_from and p_to
    and status in ('AUTO_APPROVED', 'APPROVED', 'COMPLETE');
  get diagnostics locked_count = row_count;

  insert into public.attendance_periods(
    period_start, period_end, status, closed_by, closed_at, note, updated_at,
    reopened_by, reopened_at, reopen_reason
  ) values (
    p_from, p_to, 'CLOSED', actor.employee_id, clock_timestamp(),
    left(coalesce(trim(p_note), ''), 1000), clock_timestamp(), null, null, null
  )
  on conflict(period_start, period_end) do update
  set status = 'CLOSED', closed_by = excluded.closed_by, closed_at = excluded.closed_at,
      note = excluded.note, updated_at = clock_timestamp(),
      reopened_by = null, reopened_at = null, reopen_reason = null
  returning * into period_row;

  insert into public.audit_logs(
    actor_employee_id, action, entity_type, entity_id, reason, metadata
  ) values (
    actor.employee_id, 'ATTENDANCE_PERIOD_CLOSED', 'attendance_period', period_row.id::text,
    period_row.note,
    jsonb_build_object('period_start', p_from, 'period_end', p_to, 'locked_count', locked_count)
  );
  return jsonb_build_object('period', to_jsonb(period_row), 'locked_count', locked_count);
end;
$$;

revoke all on function public.save_shift_assignments_v1(jsonb) from public, anon;
revoke all on function public.delete_shift_assignment_v1(uuid, text) from public, anon;
revoke all on function public.review_attendance_requests_bulk_v1(jsonb, text, text) from public, anon;
revoke all on function public.close_attendance_period_v1(date, date, text) from public, anon;
grant execute on function public.save_shift_assignments_v1(jsonb) to authenticated;
grant execute on function public.delete_shift_assignment_v1(uuid, text) to authenticated;
grant execute on function public.review_attendance_requests_bulk_v1(jsonb, text, text) to authenticated;
grant execute on function public.close_attendance_period_v1(date, date, text) to authenticated;
