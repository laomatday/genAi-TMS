begin;

insert into public.config_system(key, value)
values ('MISSING_CHECKIN_AFTER_MINUTES', '120')
on conflict (key) do nothing;

create or replace function public.sync_my_timesheet_v3()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  employee_row public.employees%rowtype;
  schedule jsonb;
  local_today date := (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date;
  now_at timestamptz := clock_timestamp();
  missing_after integer := 120;
begin
  if (select auth.uid()) is null then return; end if;
  select * into employee_row
  from public.employees
  where auth_user_id = (select auth.uid()) and status = 'Active';
  if not found or employee_row.role = 'Kiosk' then return; end if;

  update public.timesheets
  set status = 'EXCEPTION',
      exception_codes = case
        when 'MISSING_CHECKOUT' = any(coalesce(exception_codes, '{}'::text[])) then exception_codes
        else array_append(coalesce(exception_codes, '{}'::text[]), 'MISSING_CHECKOUT')
      end,
      updated_at = now_at
  where employee_id = employee_row.employee_id
    and work_date < local_today
    and actual_checkin is not null
    and actual_checkout is null
    and status in ('OPEN', 'COMPLETE');

  if exists(
    select 1 from public.timesheets
    where employee_id = employee_row.employee_id and work_date = local_today
  ) then return; end if;

  schedule := tms_private.resolve_schedule_v3(employee_row.employee_id, local_today);
  if schedule is null or not coalesce((schedule ->> 'workday')::boolean, false) then return; end if;

  select least(720, greatest(15, value::integer)) into missing_after
  from public.config_system
  where key = 'MISSING_CHECKIN_AFTER_MINUTES' and value ~ '^[0-9]+$';
  missing_after := coalesce(missing_after, 120);

  if now_at <= (schedule ->> 'expected_start')::timestamptz + make_interval(mins => missing_after) then return; end if;

  insert into public.timesheets(
    employee_id, work_date, policy_id, location_id,
    expected_start, expected_end, status, exception_codes, updated_at
  ) values (
    employee_row.employee_id,
    local_today,
    (schedule ->> 'policy_id')::uuid,
    coalesce(nullif(schedule ->> 'location_id', ''), employee_row.center_id),
    (schedule ->> 'expected_start')::timestamptz,
    (schedule ->> 'expected_end')::timestamptz,
    'EXCEPTION',
    array['MISSING_CHECKIN'],
    now_at
  ) on conflict(employee_id, work_date) do nothing;
end;
$$;

revoke all on function public.sync_my_timesheet_v3() from public, anon;
grant execute on function public.sync_my_timesheet_v3() to authenticated;

create or replace function public.refresh_tms_exceptions_v3(
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
  from_date_value date;
  to_date_value date;
  local_today date := (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date;
  now_at timestamptz := clock_timestamp();
  missing_after integer := 120;
  inserted_count integer := 0;
begin
  select * into actor
  from public.employees
  where auth_user_id = (select auth.uid()) and status = 'Active';
  if not found or actor.role not in ('Admin', 'HR', 'Director') then raise exception 'Forbidden'; end if;

  from_date_value := coalesce(p_from, local_today - 31);
  to_date_value := coalesce(p_to, local_today);
  if to_date_value < from_date_value or to_date_value - from_date_value > 370 then
    raise exception 'Khoảng đồng bộ ngoại lệ không hợp lệ.';
  end if;

  select least(720, greatest(15, value::integer)) into missing_after
  from public.config_system
  where key = 'MISSING_CHECKIN_AFTER_MINUTES' and value ~ '^[0-9]+$';
  missing_after := coalesce(missing_after, 120);

  update public.timesheets
  set status = 'EXCEPTION',
      exception_codes = case
        when 'MISSING_CHECKOUT' = any(coalesce(exception_codes, '{}'::text[])) then exception_codes
        else array_append(coalesce(exception_codes, '{}'::text[]), 'MISSING_CHECKOUT')
      end,
      updated_at = now_at
  where work_date between from_date_value and least(to_date_value, local_today)
    and actual_checkin is not null
    and actual_checkout is null
    and status in ('OPEN', 'COMPLETE')
    and (work_date < local_today or now_at > expected_end + interval '6 hours');

  insert into public.timesheets(
    employee_id, work_date, policy_id, location_id,
    expected_start, expected_end, status, exception_codes, updated_at
  )
  select
    employee_row.employee_id,
    day_row::date,
    (schedule.value ->> 'policy_id')::uuid,
    coalesce(nullif(schedule.value ->> 'location_id', ''), employee_row.center_id),
    (schedule.value ->> 'expected_start')::timestamptz,
    (schedule.value ->> 'expected_end')::timestamptz,
    'EXCEPTION',
    array['MISSING_CHECKIN'],
    now_at
  from public.employees employee_row
  cross join lateral generate_series(
    greatest(from_date_value, (employee_row.created_at at time zone 'Asia/Ho_Chi_Minh')::date),
    to_date_value,
    interval '1 day'
  ) day_row
  cross join lateral (
    select tms_private.resolve_schedule_v3(employee_row.employee_id, day_row::date) as value
  ) schedule
  where employee_row.status = 'Active'
    and employee_row.role <> 'Kiosk'
    and schedule.value is not null
    and coalesce((schedule.value ->> 'workday')::boolean, false)
    and (
      day_row::date < local_today
      or (
        day_row::date = local_today
        and now_at > (schedule.value ->> 'expected_start')::timestamptz + make_interval(mins => missing_after)
      )
    )
    and not exists(
      select 1 from public.timesheets existing
      where existing.employee_id = employee_row.employee_id
        and existing.work_date = day_row::date
    )
  on conflict(employee_id, work_date) do nothing;

  get diagnostics inserted_count = row_count;
  return inserted_count;
end;
$$;

revoke all on function public.refresh_tms_exceptions_v3(date, date) from public, anon;
grant execute on function public.refresh_tms_exceptions_v3(date, date) to authenticated;

create or replace function public.get_my_dashboard_v4()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.sync_my_timesheet_v3();
  return public.get_my_dashboard_v3();
end;
$$;

revoke all on function public.get_my_dashboard_v4() from public, anon;
grant execute on function public.get_my_dashboard_v4() to authenticated;

commit;
