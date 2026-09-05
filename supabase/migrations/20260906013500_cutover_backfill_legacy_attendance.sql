-- Final non-destructive legacy -> canonical backfill for the V3 cut-over.
-- No legacy row is deleted. Existing adjusted/locked canonical rows always win.

begin;

-- 1) Ensure every legacy attendance day has a canonical timesheet.
insert into public.timesheets(
  employee_id,
  work_date,
  policy_id,
  location_id,
  expected_start,
  expected_end,
  actual_checkin,
  actual_checkout,
  status,
  source,
  exception_codes,
  late_minutes,
  early_minutes,
  work_minutes,
  break_started_at,
  break_minutes,
  created_at,
  updated_at
)
select
  attendance_row.employee_id,
  attendance_row.attendance_date,
  employee_row.attendance_policy_id,
  attendance_row.center_id,
  case
    when nullif(attendance_row.shift_start, '') is not null
      then ((attendance_row.attendance_date + attendance_row.shift_start::time) at time zone 'Asia/Ho_Chi_Minh')
    else attendance_row.checked_in_at
  end,
  case
    when nullif(attendance_row.shift_end, '') is not null
      then (
        (attendance_row.attendance_date + attendance_row.shift_end::time
          + case
              when nullif(attendance_row.shift_start, '') is not null
                and attendance_row.shift_end::time <= attendance_row.shift_start::time
              then interval '1 day'
              else interval '0 day'
            end
        ) at time zone 'Asia/Ho_Chi_Minh'
      )
    else attendance_row.checked_out_at
  end,
  attendance_row.checked_in_at,
  case
    when attendance_row.status = 'Invalid'
      and coalesce(attendance_row.note, '') ilike '%quên check-out%'
      then null
    else attendance_row.checked_out_at
  end,
  case
    when attendance_row.status = 'Invalid' then 'EXCEPTION'
    when coalesce(attendance_row.time_out, '') = '' then 'OPEN'
    when coalesce(attendance_row.late_minutes, 0) > 0
      or coalesce(attendance_row.early_minutes, 0) > 0 then 'EXCEPTION'
    else 'AUTO_APPROVED'
  end,
  'LEGACY',
  array_remove(array[
    case
      when attendance_row.status = 'Invalid'
        and coalesce(attendance_row.note, '') ilike '%quên check-out%'
      then 'MISSING_CHECKOUT'
    end,
    case when coalesce(attendance_row.late_minutes, 0) > 0 then 'LATE' end,
    case when coalesce(attendance_row.early_minutes, 0) > 0 then 'EARLY_LEAVE' end,
    case
      when attendance_row.status = 'Invalid'
        and coalesce(attendance_row.note, '') not ilike '%quên check-out%'
      then 'INVALID_LEGACY'
    end
  ], null),
  coalesce(attendance_row.late_minutes, 0),
  coalesce(attendance_row.early_minutes, 0),
  round(coalesce(attendance_row.work_hours, 0) * 60)::integer,
  attendance_row.break_start,
  greatest(0, coalesce(attendance_row.total_break_mins, 0)),
  coalesce(attendance_row.checked_in_at, attendance_row.last_updated, clock_timestamp()),
  coalesce(attendance_row.last_updated, clock_timestamp())
from public.attendance attendance_row
join public.employees employee_row
  on employee_row.employee_id = attendance_row.employee_id
on conflict(employee_id, work_date) do nothing;

-- 2) Fill missing canonical fields only. Never overwrite an adjusted, reviewed or locked row.
update public.timesheets timesheet_row
set
  policy_id = coalesce(timesheet_row.policy_id, employee_row.attendance_policy_id),
  location_id = coalesce(timesheet_row.location_id, attendance_row.center_id),
  actual_checkin = coalesce(timesheet_row.actual_checkin, attendance_row.checked_in_at),
  actual_checkout = coalesce(
    timesheet_row.actual_checkout,
    case
      when attendance_row.status = 'Invalid'
        and coalesce(attendance_row.note, '') ilike '%quên check-out%'
      then null
      else attendance_row.checked_out_at
    end
  ),
  late_minutes = greatest(timesheet_row.late_minutes, coalesce(attendance_row.late_minutes, 0)),
  early_minutes = greatest(timesheet_row.early_minutes, coalesce(attendance_row.early_minutes, 0)),
  work_minutes = greatest(timesheet_row.work_minutes, round(coalesce(attendance_row.work_hours, 0) * 60)::integer),
  break_started_at = coalesce(timesheet_row.break_started_at, attendance_row.break_start),
  break_minutes = greatest(timesheet_row.break_minutes, coalesce(attendance_row.total_break_mins, 0)),
  updated_at = greatest(timesheet_row.updated_at, coalesce(attendance_row.last_updated, timesheet_row.updated_at))
from public.attendance attendance_row
join public.employees employee_row
  on employee_row.employee_id = attendance_row.employee_id
where timesheet_row.employee_id = attendance_row.employee_id
  and timesheet_row.work_date = attendance_row.attendance_date
  and timesheet_row.status not in ('LOCKED', 'APPROVED', 'PENDING_REVIEW')
  and timesheet_row.source = 'LEGACY';

-- 3) Reconstruct immutable canonical check-in events where missing.
insert into public.attendance_events(
  timesheet_id,
  employee_id,
  event_type,
  occurred_at,
  work_date,
  location_id,
  qr_station_id,
  latitude,
  longitude,
  gps_accuracy_m,
  distance_meters,
  gps_state,
  trusted_device_id,
  device_verified,
  outcome,
  validation
)
select
  timesheet_row.id,
  attendance_row.employee_id,
  'CHECK_IN',
  coalesce(attendance_row.checked_in_at, timesheet_row.created_at),
  attendance_row.attendance_date,
  attendance_row.center_id,
  attendance_row.qr_station_id,
  attendance_row.checkin_lat,
  attendance_row.checkin_lng,
  attendance_row.location_accuracy_m,
  attendance_row.distance_meters,
  case
    when coalesce(attendance_row.location_accuracy_m, 0) > 150 then 'INVALID'
    when coalesce(attendance_row.location_accuracy_m, 0) > 50 then 'UNCERTAIN'
    else 'VALID'
  end,
  nullif(attendance_row.device_id, ''),
  false,
  case when attendance_row.status = 'Invalid' then 'INVALID' else 'VALID' end,
  jsonb_build_object(
    'legacy_cutover', true,
    'legacy_attendance_id', attendance_row.id,
    'checkin_type', attendance_row.checkin_type
  )
from public.attendance attendance_row
join public.timesheets timesheet_row
  on timesheet_row.employee_id = attendance_row.employee_id
 and timesheet_row.work_date = attendance_row.attendance_date
where attendance_row.checked_in_at is not null
  and not exists(
    select 1
    from public.attendance_events event_row
    where event_row.timesheet_id = timesheet_row.id
      and event_row.event_type = 'CHECK_IN'
  );

-- 4) Reconstruct immutable canonical check-out events where missing.
insert into public.attendance_events(
  timesheet_id,
  employee_id,
  event_type,
  occurred_at,
  work_date,
  location_id,
  qr_station_id,
  latitude,
  longitude,
  gps_accuracy_m,
  distance_meters,
  gps_state,
  trusted_device_id,
  device_verified,
  outcome,
  validation
)
select
  timesheet_row.id,
  attendance_row.employee_id,
  'CHECK_OUT',
  attendance_row.checked_out_at,
  attendance_row.attendance_date,
  attendance_row.center_id,
  attendance_row.qr_station_id,
  attendance_row.checkout_lat,
  attendance_row.checkout_lng,
  attendance_row.checkout_accuracy_m,
  attendance_row.checkout_distance,
  case
    when coalesce(attendance_row.checkout_accuracy_m, 0) > 150 then 'INVALID'
    when coalesce(attendance_row.checkout_accuracy_m, 0) > 50 then 'UNCERTAIN'
    else 'VALID'
  end,
  nullif(attendance_row.device_id, ''),
  false,
  case when attendance_row.status = 'Invalid' then 'INVALID' else 'VALID' end,
  jsonb_build_object(
    'legacy_cutover', true,
    'legacy_attendance_id', attendance_row.id
  )
from public.attendance attendance_row
join public.timesheets timesheet_row
  on timesheet_row.employee_id = attendance_row.employee_id
 and timesheet_row.work_date = attendance_row.attendance_date
where attendance_row.checked_out_at is not null
  and not (
    attendance_row.status = 'Invalid'
    and coalesce(attendance_row.note, '') ilike '%quên check-out%'
  )
  and not exists(
    select 1
    from public.attendance_events event_row
    where event_row.timesheet_id = timesheet_row.id
      and event_row.event_type = 'CHECK_OUT'
  );

-- 5) Link canonical timesheets to the reconstructed events.
update public.timesheets timesheet_row
set
  checkin_event_id = coalesce(
    timesheet_row.checkin_event_id,
    (
      select event_row.id
      from public.attendance_events event_row
      where event_row.timesheet_id = timesheet_row.id
        and event_row.event_type = 'CHECK_IN'
      order by event_row.occurred_at
      limit 1
    )
  ),
  checkout_event_id = coalesce(
    timesheet_row.checkout_event_id,
    (
      select event_row.id
      from public.attendance_events event_row
      where event_row.timesheet_id = timesheet_row.id
        and event_row.event_type = 'CHECK_OUT'
      order by event_row.occurred_at desc
      limit 1
    )
  )
where timesheet_row.checkin_event_id is null
   or timesheet_row.checkout_event_id is null;

-- 6) Migrate legacy explanations created after the original V2 backfill.
insert into public.attendance_requests(
  timesheet_id,
  employee_id,
  request_type,
  exception_code,
  reason,
  status,
  manager_note,
  approver_id,
  created_at,
  updated_at
)
select
  timesheet_row.id,
  explanation_row.employee_id,
  'EXPLANATION',
  case
    when coalesce(array_length(timesheet_row.exception_codes, 1), 0) > 0
      then timesheet_row.exception_codes[1]
    else null
  end,
  explanation_row.reason,
  case explanation_row.status
    when 'Approved' then 'APPROVED'
    when 'Rejected' then 'REJECTED'
    else 'PENDING'
  end,
  explanation_row.manager_note,
  explanation_row.approver_id,
  explanation_row.created_at,
  explanation_row.updated_at
from public.attendance_explanations explanation_row
join public.timesheets timesheet_row
  on timesheet_row.employee_id = explanation_row.employee_id
 and timesheet_row.work_date = explanation_row.attendance_date
where not exists(
  select 1
  from public.attendance_requests request_row
  where request_row.timesheet_id = timesheet_row.id
    and request_row.request_type = 'EXPLANATION'
    and request_row.reason = explanation_row.reason
    and request_row.created_at = explanation_row.created_at
);

-- 7) Legacy attendance remains read-only historical data after cut-over.
revoke insert, update, delete on table public.attendance from authenticated;
revoke insert, update, delete on table public.attendance_explanations from authenticated;

insert into public.audit_logs(action, entity_type, reason, metadata)
values(
  'LEGACY_ATTENDANCE_BACKFILLED',
  'migration',
  'Hoàn tất backfill dữ liệu legacy trước khi dùng timesheets làm nguồn chuẩn',
  jsonb_build_object('migration', '20260906013500_cutover_backfill_legacy_attendance')
);

commit;
