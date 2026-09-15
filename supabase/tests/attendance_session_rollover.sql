begin;

create extension if not exists pgtap with schema extensions;
select plan(1);

insert into public.organizations (id, code, name)
values ('11000000-0000-0000-0000-000000000001', 'attendance-rollover-test', 'Attendance Rollover Test');

insert into public.locations (
  center_id, center_name, latitude, longitude, radius_meters, active, organization_id
)
values (
  'ROLLOVER-HQ', 'Rollover HQ', 10.000000, 106.000000, 200, true,
  '11000000-0000-0000-0000-000000000001'
);

insert into public.attendance_policies (
  id, name, work_days, expected_start, expected_end,
  checkin_window_start, checkin_window_end,
  checkout_window_start, checkout_window_end,
  gps_good_accuracy_m, gps_max_accuracy_m, unpaid_break_minutes,
  auto_approve, active, organization_id
)
values (
  '12000000-0000-0000-0000-000000000001', 'Rollover Test Policy',
  array[1,2,3,4,5,6,7]::smallint[], '08:30', '17:30',
  '00:00', '23:59', '00:00', '23:59', 50, 150, 60,
  true, true, '11000000-0000-0000-0000-000000000001'
);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at
)
values
  (
    '13000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'rollover-manager@example.test', '',
    clock_timestamp(), '{"provider":"email","providers":["email"]}', '{}',
    clock_timestamp(), clock_timestamp()
  ),
  (
    '13000000-0000-0000-0000-000000000002',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'rollover-worker@example.test', '',
    clock_timestamp(), '{"provider":"email","providers":["email"]}', '{}',
    clock_timestamp(), clock_timestamp()
  );

insert into public.employees (
  employee_id, auth_user_id, organization_id, name, email, role,
  center_id, status, employment_start_date, attendance_policy_id
)
values (
  'ROLLOVER-MANAGER', '13000000-0000-0000-0000-000000000001',
  '11000000-0000-0000-0000-000000000001', 'Rollover Manager',
  'rollover-manager@example.test', 'Manager', 'ROLLOVER-HQ', 'Active',
  current_date - 30, '12000000-0000-0000-0000-000000000001'
);

insert into public.employees (
  employee_id, auth_user_id, organization_id, name, email, role,
  center_id, status, employment_start_date, attendance_policy_id, direct_manager_id
)
values (
  'ROLLOVER-WORKER', '13000000-0000-0000-0000-000000000002',
  '11000000-0000-0000-0000-000000000001', 'Rollover Worker',
  'rollover-worker@example.test', 'Admin', 'ROLLOVER-HQ', 'Active',
  current_date - 30, '12000000-0000-0000-0000-000000000001', 'ROLLOVER-MANAGER'
);

insert into public.trusted_devices(
  device_id,employee_id,organization_id,public_key_jwk,
  device_label,status,activated_at
) values(
  'rollover-test-device','ROLLOVER-WORKER',
  '11000000-0000-0000-0000-000000000001',
  '{"kty":"EC","crv":"P-256","x":"test-x","y":"test-y"}',
  'Rollover test device','ACTIVE',clock_timestamp()
);

insert into public.trusted_device_grants(
  employee_id,device_id,verified_at,expires_at,updated_at
) values(
  'ROLLOVER-WORKER','rollover-test-device',clock_timestamp(),
  clock_timestamp()+interval '1 hour',clock_timestamp()
);

insert into public.qr_stations (
  station_user_id, center_id, name, active, created_by, organization_id
)
values (
  '13000000-0000-0000-0000-000000000002', 'ROLLOVER-HQ',
  'Rollover QR', true, 'ROLLOVER-WORKER',
  '11000000-0000-0000-0000-000000000001'
);

insert into public.attendance_qr_sessions (
  station_user_id, center_id, token_hash, created_by, issued_at, expires_at
)
values (
  '13000000-0000-0000-0000-000000000002', 'ROLLOVER-HQ',
  encode(extensions.digest('rollover-token', 'sha256'), 'hex'),
  'ROLLOVER-WORKER', clock_timestamp(), clock_timestamp() + interval '1 hour'
);

insert into public.timesheets (
  id, employee_id, work_date, policy_id, location_id,
  expected_start, expected_end, actual_checkin,
  status, source, exception_codes
)
values (
  '15000000-0000-0000-0000-000000000001',
  'ROLLOVER-WORKER', (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date - 1,
  '12000000-0000-0000-0000-000000000001', 'ROLLOVER-HQ',
  (((clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date - 1 + time '08:30') at time zone 'Asia/Ho_Chi_Minh'),
  (((clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date - 1 + time '17:30') at time zone 'Asia/Ho_Chi_Minh'),
  (((clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date - 1 + time '08:35') at time zone 'Asia/Ho_Chi_Minh'),
  'EXCEPTION', 'NORMAL', array['MISSING_CHECKOUT']
);

insert into public.work_sessions(
  id,organization_id,employee_internal_id,employee_id,business_date,
  session_sequence,policy_id,location_internal_id,location_id,
  expected_start,expected_end,actual_checkin,status,source,exception_codes
)
select
  timesheet.id,timesheet.organization_id,employee.internal_id,timesheet.employee_id,
  timesheet.work_date,1,timesheet.policy_id,location.internal_id,location.center_id,
  timesheet.expected_start,timesheet.expected_end,timesheet.actual_checkin,
  'OPEN','NORMAL',timesheet.exception_codes
from public.timesheets timesheet
join public.employees employee
  on employee.organization_id=timesheet.organization_id
 and employee.employee_id=timesheet.employee_id
join public.locations location
  on location.organization_id=timesheet.organization_id
 and location.center_id=timesheet.location_id
where timesheet.id='15000000-0000-0000-0000-000000000001';

set local role authenticated;
select set_config('request.jwt.claim.sub', '13000000-0000-0000-0000-000000000002', true);

do $$
declare
  result jsonb;
begin
  result := public.workforce_command('attendance', jsonb_build_object(
    'action', 'checkin',
    'command_id', '14000000-0000-4000-8000-000000000001',
    'device_id', 'rollover-test-device',
    'qr_payload', jsonb_build_object(
      'v', '1',
      's', '13000000-0000-0000-0000-000000000002',
      'c', 'ROLLOVER-HQ',
      't', 'rollover-token'
    )::text,
    'lat', 10.000000,
    'lng', 106.000000,
    'accuracy', 5
  ));
  if coalesce((result->>'ok')::boolean, false) is not true then
    raise exception 'New-day check-in was rejected: %', result;
  end if;
end;
$$;

reset role;

do $$
declare
  work_day date := (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date;
begin
  if not exists (
    select 1 from public.timesheets
    where employee_id='ROLLOVER-WORKER'
      and work_date=work_day-1
      and actual_checkout is null
      and exception_codes @> array['MISSING_CHECKOUT','SUPERSEDED_BY_NEW_CHECKIN']
  ) then
    raise exception 'Earlier unfinished session was not preserved and marked as superseded';
  end if;
  if not exists (
    select 1 from public.timesheets
    where employee_id='ROLLOVER-WORKER'
      and work_date=work_day
      and actual_checkin is not null
      and actual_checkout is null
      and status='OPEN'
  ) then
    raise exception 'Current-day session was not opened';
  end if;
end;
$$;

set local role authenticated;
select set_config('request.jwt.claim.sub', '13000000-0000-0000-0000-000000000002', true);

do $$
declare
  result jsonb;
begin
  result := public.workforce_command('attendance', jsonb_build_object(
    'action', 'checkout',
    'command_id', '14000000-0000-4000-8000-000000000002',
    'device_id', 'rollover-test-device',
    'lat', 10.000000,
    'lng', 106.000000,
    'accuracy', 5
  ));
  if coalesce((result->>'ok')::boolean, false) is not true then
    raise exception 'Checkout of the current session failed: %', result;
  end if;
end;
$$;

reset role;

do $$
declare
  work_day date := (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date;
begin
  if not exists (
    select 1 from public.timesheets
    where employee_id='ROLLOVER-WORKER' and work_date=work_day and actual_checkout is not null
  ) then
    raise exception 'Checkout did not target the newly opened session';
  end if;
  if exists (
    select 1 from public.timesheets
    where employee_id='ROLLOVER-WORKER' and work_date=work_day-1 and actual_checkout is not null
  ) then
    raise exception 'Checkout incorrectly mutated the superseded session';
  end if;
end;
$$;

set local role authenticated;
select set_config('request.jwt.claim.sub', '13000000-0000-0000-0000-000000000002', true);

do $$
declare
  work_day date := (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date - 2;
  result jsonb;
begin
  result := public.workforce_command('request.submit', jsonb_build_object(
    'request_type', 'CORRECTION',
    'from_date', work_day,
    'to_date', work_day,
    'reason', 'Quên chấm công nhưng có làm việc thực tế',
    'requested_checkin', ((work_day + time '08:30') at time zone 'Asia/Ho_Chi_Minh'),
    'requested_checkout', ((work_day + time '17:30') at time zone 'Asia/Ho_Chi_Minh')
  ));
  if coalesce((result->>'ok')::boolean, false) is not true then
    raise exception 'Missing-day correction could not be submitted: %', result;
  end if;
end;
$$;

reset role;

do $$
declare
  work_day date := (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date - 2;
begin
  if not exists (
    select 1 from public.timesheets
    where employee_id='ROLLOVER-WORKER' and work_date=work_day
      and status='PENDING_REVIEW' and actual_checkin is null and actual_checkout is null
  ) then
    raise exception 'Correction did not create a reviewable missing-day timesheet';
  end if;
end;
$$;

set local role authenticated;
select set_config('request.jwt.claim.sub', '13000000-0000-0000-0000-000000000001', true);

do $$
declare
  work_day date := (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date - 2;
  request_row jsonb;
  queue jsonb;
  result jsonb;
begin
  queue:=public.workforce_query('requests',jsonb_build_object(
    'team',true,'from',work_day,'to',work_day,'size',100
  ));
  select row into request_row
  from jsonb_array_elements(coalesce(queue->'rows','[]'::jsonb)) row
  where row->>'employee_id'='ROLLOVER-WORKER'
    and row->>'request_type'='CORRECTION'
    and (row->>'from_date')::date=work_day
  limit 1;
  if request_row is null then
    raise exception 'Missing-day correction was not visible to its approver';
  end if;
  result := public.workforce_command('request.review', jsonb_build_object(
    'id', request_row->>'id',
    'revision', (request_row->>'revision')::bigint,
    'decision', 'APPROVED',
    'note', 'Đã đối chiếu với quản lý trực tiếp'
  ));
  if coalesce((result->>'ok')::boolean, false) is not true then
    raise exception 'Missing-day correction could not be approved: %', result;
  end if;
end;
$$;

reset role;

do $$
declare
  work_day date := (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date - 2;
begin
  if not exists (
    select 1 from public.timesheets
    where employee_id='ROLLOVER-WORKER' and work_date=work_day
      and status='APPROVED' and source='ADJUSTED'
      and actual_checkin is not null and actual_checkout is not null
      and work_minutes>0
      and not (exception_codes && array['MISSING_CHECKIN','MISSING_CHECKOUT','SUPERSEDED_BY_NEW_CHECKIN'])
  ) then
    raise exception 'Approved correction did not produce an audited complete timesheet';
  end if;
  if not exists (
    select 1 from public.attendance_events event
    join public.timesheets sheet on sheet.id=event.timesheet_id
    where sheet.employee_id='ROLLOVER-WORKER' and sheet.work_date=work_day
      and event.event_type='CORRECTION'
  ) then
    raise exception 'Approved correction did not create an immutable correction event';
  end if;
end;
$$;

select pass('attendance rollover and missing-punch correction invariants hold');
select * from finish();
rollback;
