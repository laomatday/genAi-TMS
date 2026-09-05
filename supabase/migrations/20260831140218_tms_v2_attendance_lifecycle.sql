create table if not exists public.attendance_policies (
  id uuid primary key default extensions.gen_random_uuid(),
  name text not null unique,
  work_days smallint[] not null default array[1,2,3,4,5]::smallint[],
  expected_start time not null default '08:30',
  expected_end time not null default '17:30',
  late_tolerance_minutes integer not null default 5 check (late_tolerance_minutes between 0 and 180),
  early_tolerance_minutes integer not null default 5 check (early_tolerance_minutes between 0 and 180),
  checkin_window_start time not null default '07:30',
  checkin_window_end time not null default '10:00',
  checkout_window_start time not null default '16:00',
  checkout_window_end time not null default '20:00',
  gps_good_accuracy_m integer not null default 50 check (gps_good_accuracy_m between 5 and 500),
  gps_max_accuracy_m integer not null default 150 check (gps_max_accuracy_m between 10 and 1000),
  unpaid_break_minutes integer not null default 90 check (unpaid_break_minutes between 0 and 360),
  auto_approve boolean not null default true,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.employees add column if not exists attendance_policy_id uuid references public.attendance_policies(id);

insert into public.attendance_policies(name, work_days, expected_start, expected_end, late_tolerance_minutes, early_tolerance_minutes, checkin_window_start, checkin_window_end, checkout_window_start, checkout_window_end, gps_good_accuracy_m, gps_max_accuracy_m, unpaid_break_minutes, auto_approve)
values ('Chuẩn văn phòng', array[1,2,3,4,5]::smallint[], '08:30', '17:30', 5, 5, '07:30', '10:00', '16:00', '20:00', 50, 150, 90, true)
on conflict (name) do nothing;

update public.employees
set attendance_policy_id = (select id from public.attendance_policies where name='Chuẩn văn phòng' limit 1)
where attendance_policy_id is null and role <> 'Kiosk';

create table if not exists public.qr_stations (
  id uuid primary key default extensions.gen_random_uuid(),
  station_user_id uuid not null unique,
  center_id text not null,
  name text not null default 'Trạm QR',
  active boolean not null default true,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.trusted_devices (
  device_id text primary key,
  employee_id text not null references public.employees(employee_id) on delete cascade,
  public_key_jwk jsonb not null,
  device_label text,
  user_agent text,
  status text not null default 'ACTIVE' check (status in ('ACTIVE','REVOKED')),
  activated_at timestamptz not null default now(),
  last_seen_at timestamptz,
  revoked_at timestamptz,
  revoked_by text,
  revoke_reason text,
  created_at timestamptz not null default now()
);
create unique index if not exists trusted_devices_one_active_per_employee on public.trusted_devices(employee_id) where status='ACTIVE';

create table if not exists public.trusted_device_challenges (
  id uuid primary key default extensions.gen_random_uuid(),
  employee_id text not null references public.employees(employee_id) on delete cascade,
  device_id text not null,
  challenge text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists trusted_device_challenges_lookup on public.trusted_device_challenges(employee_id, device_id, expires_at desc);

create table if not exists public.trusted_device_grants (
  employee_id text primary key references public.employees(employee_id) on delete cascade,
  device_id text not null,
  verified_at timestamptz not null default now(),
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.timesheets (
  id uuid primary key default extensions.gen_random_uuid(),
  employee_id text not null references public.employees(employee_id) on delete cascade,
  work_date date not null,
  policy_id uuid references public.attendance_policies(id),
  location_id text,
  expected_start timestamptz,
  expected_end timestamptz,
  actual_checkin timestamptz,
  actual_checkout timestamptz,
  status text not null default 'OPEN' check (status in ('OPEN','COMPLETE','AUTO_APPROVED','EXCEPTION','PENDING_REVIEW','APPROVED','REJECTED','LOCKED')),
  source text not null default 'NORMAL' check (source in ('NORMAL','ADJUSTED','LEGACY')),
  exception_codes text[] not null default '{}'::text[],
  late_minutes integer not null default 0,
  early_minutes integer not null default 0,
  work_minutes integer not null default 0,
  checkin_event_id uuid,
  checkout_event_id uuid,
  locked_at timestamptz,
  locked_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(employee_id, work_date)
);
create index if not exists timesheets_work_date_idx on public.timesheets(work_date desc);
create index if not exists timesheets_status_idx on public.timesheets(status, work_date desc);

create table if not exists public.attendance_events (
  id uuid primary key default extensions.gen_random_uuid(),
  timesheet_id uuid references public.timesheets(id) on delete set null,
  employee_id text not null references public.employees(employee_id) on delete cascade,
  event_type text not null check (event_type in ('CHECK_IN','CHECK_OUT','FAILED_ATTEMPT')),
  occurred_at timestamptz not null default now(),
  work_date date not null,
  location_id text,
  qr_station_id uuid,
  latitude double precision,
  longitude double precision,
  gps_accuracy_m double precision,
  distance_meters double precision,
  gps_state text check (gps_state in ('VALID','UNCERTAIN','INVALID')),
  trusted_device_id text,
  device_verified boolean not null default false,
  outcome text not null default 'VALID' check (outcome in ('VALID','UNCERTAIN','INVALID')),
  failure_code text,
  validation jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists attendance_events_employee_idx on public.attendance_events(employee_id, occurred_at desc);
create index if not exists attendance_events_failed_idx on public.attendance_events(outcome, occurred_at desc);

alter table public.timesheets drop constraint if exists timesheets_checkin_event_fk;
alter table public.timesheets add constraint timesheets_checkin_event_fk foreign key (checkin_event_id) references public.attendance_events(id) on delete set null;
alter table public.timesheets drop constraint if exists timesheets_checkout_event_fk;
alter table public.timesheets add constraint timesheets_checkout_event_fk foreign key (checkout_event_id) references public.attendance_events(id) on delete set null;

create table if not exists public.attendance_requests (
  id uuid primary key default extensions.gen_random_uuid(),
  timesheet_id uuid not null references public.timesheets(id) on delete cascade,
  employee_id text not null references public.employees(employee_id) on delete cascade,
  request_type text not null check (request_type in ('EXPLANATION','CORRECTION')),
  exception_code text,
  requested_checkin timestamptz,
  requested_checkout timestamptz,
  reason text not null,
  status text not null default 'PENDING' check (status in ('PENDING','APPROVED','REJECTED')),
  manager_note text,
  approver_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists attendance_requests_queue_idx on public.attendance_requests(status, created_at);

create table if not exists public.audit_logs (
  id uuid primary key default extensions.gen_random_uuid(),
  actor_employee_id text,
  target_employee_id text,
  action text not null,
  entity_type text,
  entity_id text,
  reason text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists audit_logs_target_idx on public.audit_logs(target_employee_id, created_at desc);

-- Backfill legacy attendance into canonical timesheets without deleting legacy records.
insert into public.timesheets(employee_id, work_date, location_id, expected_start, expected_end, actual_checkin, actual_checkout, status, source, exception_codes, late_minutes, early_minutes, work_minutes, created_at, updated_at)
select a.employee_id,
       a.attendance_date,
       a.center_id,
       case when nullif(a.shift_start,'') is not null then ((a.attendance_date + a.shift_start::time) at time zone 'Asia/Ho_Chi_Minh') else null end,
       case when nullif(a.shift_end,'') is not null then ((a.attendance_date + a.shift_end::time) at time zone 'Asia/Ho_Chi_Minh') else null end,
       a.checked_in_at,
       case when a.status='Invalid' and coalesce(a.note,'') ilike '%quên check-out%' then null else a.checked_out_at end,
       case
         when a.status='Invalid' then 'EXCEPTION'
         when coalesce(a.time_out,'')='' then 'OPEN'
         when coalesce(a.late_minutes,0)>0 or coalesce(a.early_minutes,0)>0 then 'EXCEPTION'
         else 'AUTO_APPROVED'
       end,
       'LEGACY',
       array_remove(array[
         case when a.status='Invalid' and coalesce(a.note,'') ilike '%quên check-out%' then 'MISSING_CHECKOUT' end,
         case when coalesce(a.late_minutes,0)>0 then 'LATE' end,
         case when coalesce(a.early_minutes,0)>0 then 'EARLY_LEAVE' end,
         case when a.status='Invalid' and coalesce(a.note,'') not ilike '%quên check-out%' then 'INVALID_LEGACY' end
       ], null),
       coalesce(a.late_minutes,0), coalesce(a.early_minutes,0), round(coalesce(a.work_hours,0)*60)::integer,
       coalesce(a.checked_in_at, a.last_updated, now()), coalesce(a.last_updated, now())
from public.attendance a
on conflict (employee_id, work_date) do nothing;

insert into public.attendance_events(timesheet_id, employee_id, event_type, occurred_at, work_date, location_id, qr_station_id, latitude, longitude, gps_accuracy_m, distance_meters, gps_state, trusted_device_id, device_verified, outcome, validation)
select t.id, a.employee_id, 'CHECK_IN', coalesce(a.checked_in_at, t.created_at), a.attendance_date, a.center_id, a.qr_station_id, a.checkin_lat, a.checkin_lng, a.location_accuracy_m, a.distance_meters,
       case when coalesce(a.location_accuracy_m,0)>150 then 'INVALID' when coalesce(a.location_accuracy_m,0)>50 then 'UNCERTAIN' else 'VALID' end,
       a.device_id, a.device_id is not null, case when a.status='Invalid' then 'INVALID' else 'VALID' end,
       jsonb_build_object('legacy',true,'checkin_type',a.checkin_type)
from public.attendance a join public.timesheets t on t.employee_id=a.employee_id and t.work_date=a.attendance_date
where a.checked_in_at is not null
and not exists (select 1 from public.attendance_events e where e.timesheet_id=t.id and e.event_type='CHECK_IN');

insert into public.attendance_events(timesheet_id, employee_id, event_type, occurred_at, work_date, location_id, qr_station_id, latitude, longitude, gps_accuracy_m, distance_meters, gps_state, trusted_device_id, device_verified, outcome, validation)
select t.id, a.employee_id, 'CHECK_OUT', a.checked_out_at, a.attendance_date, a.center_id, a.qr_station_id, a.checkout_lat, a.checkout_lng, a.checkout_accuracy_m, a.checkout_distance,
       case when coalesce(a.checkout_accuracy_m,0)>150 then 'INVALID' when coalesce(a.checkout_accuracy_m,0)>50 then 'UNCERTAIN' else 'VALID' end,
       a.device_id, a.device_id is not null, case when a.status='Invalid' then 'INVALID' else 'VALID' end,
       jsonb_build_object('legacy',true)
from public.attendance a join public.timesheets t on t.employee_id=a.employee_id and t.work_date=a.attendance_date
where a.checked_out_at is not null and not (a.status='Invalid' and coalesce(a.note,'') ilike '%quên check-out%')
and not exists (select 1 from public.attendance_events e where e.timesheet_id=t.id and e.event_type='CHECK_OUT');

update public.timesheets t set
  checkin_event_id = (select e.id from public.attendance_events e where e.timesheet_id=t.id and e.event_type='CHECK_IN' order by e.occurred_at limit 1),
  checkout_event_id = (select e.id from public.attendance_events e where e.timesheet_id=t.id and e.event_type='CHECK_OUT' order by e.occurred_at desc limit 1)
where t.source='LEGACY';

-- Existing simple explanations become V2 explanation requests where a canonical timesheet exists.
insert into public.attendance_requests(timesheet_id, employee_id, request_type, reason, status, manager_note, approver_id, created_at, updated_at)
select t.id, x.employee_id, 'EXPLANATION', x.reason,
       case x.status when 'Approved' then 'APPROVED' when 'Rejected' then 'REJECTED' else 'PENDING' end,
       x.manager_note, x.approver_id, x.created_at, x.updated_at
from public.attendance_explanations x
join public.timesheets t on t.employee_id=x.employee_id and t.work_date=x.attendance_date
where not exists (select 1 from public.attendance_requests r where r.timesheet_id=t.id and r.reason=x.reason and r.created_at=x.created_at);

create or replace function tms_private.prevent_attendance_event_mutation()
returns trigger language plpgsql set search_path='' as $$
begin
  raise exception 'Raw attendance events are immutable.';
end; $$;
drop trigger if exists attendance_events_immutable on public.attendance_events;
create trigger attendance_events_immutable before update or delete on public.attendance_events for each row execute function tms_private.prevent_attendance_event_mutation();

alter table public.attendance_policies enable row level security;
alter table public.qr_stations enable row level security;
alter table public.trusted_devices enable row level security;
alter table public.trusted_device_challenges enable row level security;
alter table public.trusted_device_grants enable row level security;
alter table public.timesheets enable row level security;
alter table public.attendance_events enable row level security;
alter table public.attendance_requests enable row level security;
alter table public.audit_logs enable row level security;

create policy "tms_v2_policy_read" on public.attendance_policies for select to authenticated using (active or exists(select 1 from public.employees e where e.auth_user_id=auth.uid() and e.role in ('Admin','HR','Director')));
create policy "tms_v2_policy_admin_write" on public.attendance_policies for all to authenticated using (exists(select 1 from public.employees e where e.auth_user_id=auth.uid() and e.role='Admin' and e.status='Active')) with check (exists(select 1 from public.employees e where e.auth_user_id=auth.uid() and e.role='Admin' and e.status='Active'));
create policy "tms_v2_qr_read" on public.qr_stations for select to authenticated using (true);
create policy "tms_v2_qr_admin_write" on public.qr_stations for all to authenticated using (exists(select 1 from public.employees e where e.auth_user_id=auth.uid() and e.role in ('Admin','HR','Director','Kiosk') and e.status='Active')) with check (exists(select 1 from public.employees e where e.auth_user_id=auth.uid() and e.role in ('Admin','HR','Director','Kiosk') and e.status='Active'));
create policy "tms_v2_devices_read" on public.trusted_devices for select to authenticated using (employee_id=tms_private.current_employee_id() or tms_private.can_manage_employee(employee_id));
create policy "tms_v2_challenges_own" on public.trusted_device_challenges for select to authenticated using (employee_id=tms_private.current_employee_id());
create policy "tms_v2_grants_own" on public.trusted_device_grants for select to authenticated using (employee_id=tms_private.current_employee_id());
create policy "tms_v2_timesheets_read" on public.timesheets for select to authenticated using (employee_id=tms_private.current_employee_id() or tms_private.can_manage_employee(employee_id));
create policy "tms_v2_events_read" on public.attendance_events for select to authenticated using (employee_id=tms_private.current_employee_id() or tms_private.can_manage_employee(employee_id));
create policy "tms_v2_requests_read" on public.attendance_requests for select to authenticated using (employee_id=tms_private.current_employee_id() or tms_private.can_manage_employee(employee_id));
create policy "tms_v2_audit_admin_read" on public.audit_logs for select to authenticated using (exists(select 1 from public.employees e where e.auth_user_id=auth.uid() and e.role in ('Admin','HR','Director') and e.status='Active'));

create or replace function public.sync_my_timesheet_v2()
returns void language plpgsql security definer set search_path='' as $$
declare e public.employees%rowtype; p public.attendance_policies%rowtype; d date; lt time; expected_start_at timestamptz; expected_end_at timestamptz;
begin
  if auth.uid() is null then raise exception 'Vui lòng đăng nhập.'; end if;
  select * into e from public.employees where auth_user_id=auth.uid() and status='Active';
  if not found or e.role='Kiosk' then return; end if;
  select * into p from public.attendance_policies where id=e.attendance_policy_id and active;
  if not found then select * into p from public.attendance_policies where active order by created_at limit 1; end if;
  if not found then return; end if;
  d := (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date;
  lt := (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::time;

  update public.timesheets set status='EXCEPTION', exception_codes=array_append(array_remove(coalesce(exception_codes,'{}'::text[]),'MISSING_CHECKOUT'),'MISSING_CHECKOUT'), updated_at=now()
  where employee_id=e.employee_id and work_date<d and actual_checkin is not null and actual_checkout is null and status in ('OPEN','COMPLETE');

  if extract(isodow from d)::smallint = any(p.work_days) and lt > p.checkin_window_end and not exists(select 1 from public.timesheets t where t.employee_id=e.employee_id and t.work_date=d) then
    expected_start_at := ((d + p.expected_start) at time zone 'Asia/Ho_Chi_Minh');
    expected_end_at := ((d + p.expected_end) at time zone 'Asia/Ho_Chi_Minh');
    insert into public.timesheets(employee_id,work_date,policy_id,location_id,expected_start,expected_end,status,exception_codes)
    values(e.employee_id,d,p.id,e.center_id,expected_start_at,expected_end_at,'EXCEPTION',array['MISSING_CHECKIN']);
  end if;
end; $$;

create or replace function public.get_my_tms_v2()
returns jsonb language plpgsql security definer set search_path='' as $$
declare e public.employees%rowtype; p public.attendance_policies%rowtype; l public.locations%rowtype; today_row public.timesheets%rowtype; ts jsonb; req jsonb; dev jsonb; d date;
begin
  perform public.sync_my_timesheet_v2();
  select * into e from public.employees where auth_user_id=auth.uid() and status='Active';
  if not found then raise exception 'Không tìm thấy hồ sơ nhân viên.'; end if;
  d := (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date;
  select * into p from public.attendance_policies where id=e.attendance_policy_id;
  select * into l from public.locations where center_id=e.center_id;
  select * into today_row from public.timesheets where employee_id=e.employee_id and work_date=d;
  select coalesce(jsonb_agg(to_jsonb(t) order by t.work_date desc),'[]'::jsonb) into ts from (select * from public.timesheets where employee_id=e.employee_id order by work_date desc limit 120) t;
  select coalesce(jsonb_agg(to_jsonb(r) order by r.created_at desc),'[]'::jsonb) into req from public.attendance_requests r where r.employee_id=e.employee_id;
  select to_jsonb(td) into dev from public.trusted_devices td where td.employee_id=e.employee_id and td.status='ACTIVE' order by td.activated_at desc limit 1;
  return jsonb_build_object('profile',to_jsonb(e),'policy',case when p.id is null then null else to_jsonb(p) end,'location',case when l.center_id is null then null else to_jsonb(l) end,'todayTimesheet',case when today_row.id is null then null else to_jsonb(today_row) end,'timesheets',ts,'requests',req,'trustedDevice',dev,'serverTime',clock_timestamp());
end; $$;

create or replace function public.refresh_tms_exceptions_v2(p_from date default null, p_to date default null)
returns integer language plpgsql security definer set search_path='' as $$
declare actor public.employees%rowtype; from_d date; to_d date; inserted_count integer:=0;
begin
  select * into actor from public.employees where auth_user_id=auth.uid() and status='Active';
  if not found or actor.role not in ('Admin','HR','Director') then raise exception 'Forbidden'; end if;
  from_d := coalesce(p_from, ((clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date - 31));
  to_d := coalesce(p_to, (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date);
  update public.timesheets set status='EXCEPTION', exception_codes=array_append(array_remove(coalesce(exception_codes,'{}'::text[]),'MISSING_CHECKOUT'),'MISSING_CHECKOUT'), updated_at=now()
  where work_date<=(clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date and actual_checkin is not null and actual_checkout is null and status in ('OPEN','COMPLETE') and (work_date < (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date or (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::time > '23:00'::time);

  insert into public.timesheets(employee_id,work_date,policy_id,location_id,expected_start,expected_end,status,exception_codes)
  select e.employee_id, g::date, p.id, e.center_id,
         ((g::date + p.expected_start) at time zone 'Asia/Ho_Chi_Minh'),
         ((g::date + p.expected_end) at time zone 'Asia/Ho_Chi_Minh'),
         'EXCEPTION', array['MISSING_CHECKIN']
  from public.employees e
  join public.attendance_policies p on p.id=e.attendance_policy_id and p.active
  cross join lateral generate_series(greatest(from_d, (e.created_at at time zone 'Asia/Ho_Chi_Minh')::date), to_d, interval '1 day') g
  where e.status='Active' and e.role<>'Kiosk'
    and extract(isodow from g)::smallint = any(p.work_days)
    and (g::date < (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date or (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::time > p.checkin_window_end)
    and not exists(select 1 from public.timesheets t where t.employee_id=e.employee_id and t.work_date=g::date)
  on conflict(employee_id,work_date) do nothing;
  get diagnostics inserted_count = row_count;
  return inserted_count;
end; $$;

create or replace function public.record_qr_attendance_v2(p_qr_payload text, p_lat double precision, p_lng double precision, p_accuracy double precision, p_device_id text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare e public.employees%rowtype; p public.attendance_policies%rowtype; l public.locations%rowtype; s public.attendance_qr_sessions%rowtype; t public.timesheets%rowtype; qr jsonb; qr_station uuid; qr_center text; qr_token text; qr_expiry bigint; now_at timestamptz:=clock_timestamp(); d date; lt time; dist double precision; expected_start_at timestamptz; expected_end_at timestamptz; late_m integer:=0; early_m integer:=0; total_m integer:=0; codes text[]:='{}'::text[]; event_id uuid; gps_state text:='VALID'; workday boolean; device_ok boolean:=false;
begin
  if auth.uid() is null then raise exception 'Vui lòng đăng nhập.'; end if;
  select * into e from public.employees where auth_user_id=auth.uid() and status='Active';
  if not found then raise exception 'Không tìm thấy hồ sơ nhân viên.'; end if;
  if e.role='Kiosk' then raise exception 'Tài khoản Kiosk không được chấm công.'; end if;
  select * into p from public.attendance_policies where id=e.attendance_policy_id and active;
  if not found then return jsonb_build_object('success',false,'code','POLICY_MISSING','message','Tài khoản chưa được gán chính sách chấm công.'); end if;

  if e.role='Admin' then device_ok:=true;
  else
    select exists(select 1 from public.trusted_device_grants g join public.trusted_devices td on td.employee_id=g.employee_id and td.device_id=g.device_id and td.status='ACTIVE' where g.employee_id=e.employee_id and g.device_id=p_device_id and g.expires_at>now_at) into device_ok;
  end if;
  if not device_ok then return jsonb_build_object('success',false,'code','DEVICE_NOT_VERIFIED','message','Thiết bị chưa được xác thực. Vui lòng đăng nhập lại hoặc liên hệ Admin.'); end if;

  begin qr:=p_qr_payload::jsonb; qr_station:=(qr->>'s')::uuid; qr_center:=qr->>'c'; qr_token:=qr->>'t'; qr_expiry:=(qr->>'e')::bigint; exception when others then return jsonb_build_object('success',false,'code','QR_INVALID','message','Mã QR không đúng định dạng.'); end;
  if coalesce((qr->>'v')::integer,0)<>1 or qr_center is null or qr_token is null then return jsonb_build_object('success',false,'code','QR_INVALID','message','Mã QR thiếu dữ liệu xác thực.'); end if;
  if qr_expiry < floor(extract(epoch from now_at)*1000)-2000 then return jsonb_build_object('success',false,'code','QR_EXPIRED','message','Mã QR đã hết hạn. Vui lòng quét mã mới.'); end if;
  select * into s from public.attendance_qr_sessions where station_user_id=qr_station;
  if not found or s.center_id<>qr_center or s.expires_at<now_at or s.token_hash<>encode(extensions.digest(qr_token,'sha256'),'hex') then return jsonb_build_object('success',false,'code','QR_EXPIRED','message','Mã QR đã đổi hoặc không còn hiệu lực.'); end if;

  d := (now_at at time zone 'Asia/Ho_Chi_Minh')::date; lt := (now_at at time zone 'Asia/Ho_Chi_Minh')::time;
  if p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180 or p_accuracy is null or p_accuracy<=0 then return jsonb_build_object('success',false,'code','GPS_INVALID','message','Dữ liệu định vị không hợp lệ.'); end if;
  if qr_center<>e.center_id and not (qr_center=any(coalesce(e.allowed_locations,'{}'::text[]))) then return jsonb_build_object('success',false,'code','LOCATION_NOT_ALLOWED','message','Bạn không được chấm công tại địa điểm này.'); end if;
  select * into l from public.locations where center_id=qr_center and active;
  if not found then return jsonb_build_object('success',false,'code','LOCATION_MISSING','message','Địa điểm chưa cấu hình GPS.'); end if;
  dist := tms_private.distance_meters(p_lat,p_lng,l.latitude,l.longitude);
  if p_accuracy>p.gps_max_accuracy_m then gps_state:='INVALID'; elsif p_accuracy>p.gps_good_accuracy_m then gps_state:='UNCERTAIN'; end if;
  if gps_state<>'VALID' then
    insert into public.attendance_events(employee_id,event_type,occurred_at,work_date,location_id,qr_station_id,latitude,longitude,gps_accuracy_m,distance_meters,gps_state,trusted_device_id,device_verified,outcome,failure_code,validation)
    values(e.employee_id,'FAILED_ATTEMPT',now_at,d,qr_center,qr_station,p_lat,p_lng,p_accuracy,dist,gps_state,p_device_id,device_ok,gps_state,case when gps_state='UNCERTAIN' then 'GPS_UNCERTAIN' else 'GPS_ACCURACY' end,jsonb_build_object('radius',l.radius_meters,'good_accuracy',p.gps_good_accuracy_m,'max_accuracy',p.gps_max_accuracy_m));
    return jsonb_build_object('success',false,'code',case when gps_state='UNCERTAIN' then 'GPS_UNCERTAIN' else 'GPS_ACCURACY' end,'message',case when gps_state='UNCERTAIN' then 'GPS chưa đủ chính xác ('||round(p_accuracy)||'m). Hãy giữ máy ổn định và thử lại.' else 'Độ chính xác GPS quá thấp ('||round(p_accuracy)||'m). Hãy ra vị trí thoáng và thử lại.' end,'gpsState',gps_state);
  end if;
  if dist>greatest(20,l.radius_meters) then
    insert into public.attendance_events(employee_id,event_type,occurred_at,work_date,location_id,qr_station_id,latitude,longitude,gps_accuracy_m,distance_meters,gps_state,trusted_device_id,device_verified,outcome,failure_code,validation)
    values(e.employee_id,'FAILED_ATTEMPT',now_at,d,qr_center,qr_station,p_lat,p_lng,p_accuracy,dist,'INVALID',p_device_id,device_ok,'INVALID','OUTSIDE_GEOFENCE',jsonb_build_object('radius',l.radius_meters));
    return jsonb_build_object('success',false,'code','OUTSIDE_GEOFENCE','message','Bạn đang cách '||l.center_name||' '||round(dist)||'m; bán kính cho phép là '||l.radius_meters||'m.');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(e.employee_id||':'||d::text));
  perform public.sync_my_timesheet_v2();
  select * into t from public.timesheets where employee_id=e.employee_id and work_date=d for update;
  expected_start_at := ((d+p.expected_start) at time zone 'Asia/Ho_Chi_Minh'); expected_end_at := ((d+p.expected_end) at time zone 'Asia/Ho_Chi_Minh');
  workday := extract(isodow from d)::smallint=any(p.work_days);

  if not found or t.actual_checkin is null then
    if found and t.status='LOCKED' then return jsonb_build_object('success',false,'code','LOCKED','message','Ngày công đã khóa.'); end if;
    if not workday then codes:=array_append(codes,'UNSCHEDULED_DAY'); end if;
    if lt<p.checkin_window_start or lt>p.checkin_window_end then codes:=array_append(codes,'OUTSIDE_CHECKIN_WINDOW'); end if;
    if now_at>expected_start_at+make_interval(mins=>p.late_tolerance_minutes) then late_m:=greatest(0,floor(extract(epoch from(now_at-expected_start_at))/60)::integer); codes:=array_append(codes,'LATE'); end if;
    if found then
      codes:=array_remove(coalesce(t.exception_codes,'{}'::text[]),'MISSING_CHECKIN');
      if not workday and not ('UNSCHEDULED_DAY'=any(codes)) then codes:=array_append(codes,'UNSCHEDULED_DAY'); end if;
      if (lt<p.checkin_window_start or lt>p.checkin_window_end) and not ('OUTSIDE_CHECKIN_WINDOW'=any(codes)) then codes:=array_append(codes,'OUTSIDE_CHECKIN_WINDOW'); end if;
      if late_m>0 and not ('LATE'=any(codes)) then codes:=array_append(codes,'LATE'); end if;
      update public.timesheets set policy_id=p.id,location_id=qr_center,expected_start=expected_start_at,expected_end=expected_end_at,actual_checkin=now_at,status='OPEN',exception_codes=codes,late_minutes=late_m,updated_at=now_at where id=t.id returning * into t;
    else
      insert into public.timesheets(employee_id,work_date,policy_id,location_id,expected_start,expected_end,actual_checkin,status,exception_codes,late_minutes)
      values(e.employee_id,d,p.id,qr_center,expected_start_at,expected_end_at,now_at,'OPEN',codes,late_m) returning * into t;
    end if;
    insert into public.attendance_events(timesheet_id,employee_id,event_type,occurred_at,work_date,location_id,qr_station_id,latitude,longitude,gps_accuracy_m,distance_meters,gps_state,trusted_device_id,device_verified,outcome,validation)
    values(t.id,e.employee_id,'CHECK_IN',now_at,d,qr_center,qr_station,p_lat,p_lng,p_accuracy,dist,'VALID',p_device_id,device_ok,'VALID',jsonb_build_object('policy_id',p.id,'radius',l.radius_meters,'qr_verified',true)) returning id into event_id;
    update public.timesheets set checkin_event_id=event_id where id=t.id returning * into t;
    return jsonb_build_object('success',true,'action','checkin','message','Check-in thành công tại '||l.center_name||'.','timesheet',to_jsonb(t));
  end if;

  if t.actual_checkout is not null or t.status='LOCKED' then return jsonb_build_object('success',false,'code','ALREADY_COMPLETE','message','Bạn đã hoàn tất chấm công hôm nay.'); end if;
  codes:=coalesce(t.exception_codes,'{}'::text[]);
  if lt<p.checkout_window_start or lt>p.checkout_window_end then codes:=array_append(codes,'OUTSIDE_CHECKOUT_WINDOW'); end if;
  if now_at<expected_end_at-make_interval(mins=>p.early_tolerance_minutes) then early_m:=greatest(0,floor(extract(epoch from(expected_end_at-now_at))/60)::integer); if not ('EARLY_LEAVE'=any(codes)) then codes:=array_append(codes,'EARLY_LEAVE'); end if; end if;
  total_m:=greatest(0,floor(extract(epoch from(now_at-t.actual_checkin))/60)::integer); if total_m>=360 then total_m:=greatest(0,total_m-p.unpaid_break_minutes); end if;
  insert into public.attendance_events(timesheet_id,employee_id,event_type,occurred_at,work_date,location_id,qr_station_id,latitude,longitude,gps_accuracy_m,distance_meters,gps_state,trusted_device_id,device_verified,outcome,validation)
  values(t.id,e.employee_id,'CHECK_OUT',now_at,d,qr_center,qr_station,p_lat,p_lng,p_accuracy,dist,'VALID',p_device_id,device_ok,'VALID',jsonb_build_object('policy_id',p.id,'radius',l.radius_meters,'qr_verified',true)) returning id into event_id;
  update public.timesheets set actual_checkout=now_at,checkout_event_id=event_id,early_minutes=early_m,work_minutes=total_m,exception_codes=codes,status=case when coalesce(array_length(codes,1),0)=0 and p.auto_approve then 'AUTO_APPROVED' when coalesce(array_length(codes,1),0)=0 then 'COMPLETE' else 'EXCEPTION' end,updated_at=now_at where id=t.id returning * into t;
  return jsonb_build_object('success',true,'action','checkout','message','Check-out thành công tại '||l.center_name||'.','timesheet',to_jsonb(t));
end; $$;

create or replace function public.submit_attendance_request_v2(p_timesheet_id uuid,p_request_type text,p_reason text,p_requested_checkin timestamptz default null,p_requested_checkout timestamptz default null)
returns public.attendance_requests language plpgsql security definer set search_path='' as $$
declare e public.employees%rowtype; t public.timesheets%rowtype; r public.attendance_requests%rowtype;
begin
  select * into e from public.employees where auth_user_id=auth.uid() and status='Active'; if not found then raise exception 'Không tìm thấy nhân viên.'; end if;
  select * into t from public.timesheets where id=p_timesheet_id and employee_id=e.employee_id for update; if not found then raise exception 'Không tìm thấy ngày công.'; end if;
  if t.status='LOCKED' then raise exception 'Ngày công đã khóa.'; end if;
  if p_request_type not in ('EXPLANATION','CORRECTION') then raise exception 'Loại yêu cầu không hợp lệ.'; end if;
  if length(trim(coalesce(p_reason,'')))<3 then raise exception 'Vui lòng nhập lý do.'; end if;
  if exists(select 1 from public.attendance_requests x where x.timesheet_id=t.id and x.status='PENDING') then raise exception 'Ngày này đã có yêu cầu đang chờ duyệt.'; end if;
  if p_request_type='CORRECTION' and p_requested_checkin is null and p_requested_checkout is null then raise exception 'Điều chỉnh công cần có giờ đề nghị.'; end if;
  insert into public.attendance_requests(timesheet_id,employee_id,request_type,exception_code,requested_checkin,requested_checkout,reason,status)
  values(t.id,e.employee_id,p_request_type,case when coalesce(array_length(t.exception_codes,1),0)>0 then t.exception_codes[1] else null end,p_requested_checkin,p_requested_checkout,trim(p_reason),'PENDING') returning * into r;
  update public.timesheets set status='PENDING_REVIEW',updated_at=now() where id=t.id;
  insert into public.audit_logs(actor_employee_id,target_employee_id,action,entity_type,entity_id,reason,metadata) values(e.employee_id,e.employee_id,'ATTENDANCE_REQUEST_SUBMITTED','attendance_request',r.id::text,r.reason,jsonb_build_object('type',p_request_type,'timesheet_id',t.id));
  return r;
end; $$;

create or replace function public.review_attendance_request_v2(p_id uuid,p_status text,p_note text default '')
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.attendance_requests%rowtype; t public.timesheets%rowtype; p public.attendance_policies%rowtype; actor text; new_codes text[]:='{}'::text[]; new_in timestamptz; new_out timestamptz; late_m integer:=0; early_m integer:=0; work_m integer:=0;
begin
  if p_status not in ('APPROVED','REJECTED') then raise exception 'Trạng thái không hợp lệ.'; end if;
  select * into r from public.attendance_requests where id=p_id for update; if not found then raise exception 'Không tìm thấy yêu cầu.'; end if;
  if not tms_private.can_manage_employee(r.employee_id) then raise exception 'Forbidden'; end if;
  actor:=tms_private.current_employee_id();
  select * into t from public.timesheets where id=r.timesheet_id for update; if not found then raise exception 'Không tìm thấy timesheet.'; end if;
  if t.status='LOCKED' then raise exception 'Ngày công đã khóa.'; end if;
  update public.attendance_requests set status=p_status,manager_note=coalesce(p_note,''),approver_id=actor,updated_at=now() where id=r.id;
  if p_status='REJECTED' then
    update public.timesheets set status='EXCEPTION',updated_at=now() where id=t.id returning * into t;
  else
    if r.request_type='CORRECTION' then
      select * into p from public.attendance_policies where id=t.policy_id;
      new_in:=coalesce(r.requested_checkin,t.actual_checkin); new_out:=coalesce(r.requested_checkout,t.actual_checkout);
      if new_in is null then new_codes:=array_append(new_codes,'MISSING_CHECKIN'); end if;
      if new_out is null then new_codes:=array_append(new_codes,'MISSING_CHECKOUT'); end if;
      if new_in is not null and t.expected_start is not null and new_in>t.expected_start+make_interval(mins=>coalesce(p.late_tolerance_minutes,5)) then late_m:=greatest(0,floor(extract(epoch from(new_in-t.expected_start))/60)::integer); new_codes:=array_append(new_codes,'LATE'); end if;
      if new_out is not null and t.expected_end is not null and new_out<t.expected_end-make_interval(mins=>coalesce(p.early_tolerance_minutes,5)) then early_m:=greatest(0,floor(extract(epoch from(t.expected_end-new_out))/60)::integer); new_codes:=array_append(new_codes,'EARLY_LEAVE'); end if;
      if new_in is not null and new_out is not null then work_m:=greatest(0,floor(extract(epoch from(new_out-new_in))/60)::integer); if work_m>=360 then work_m:=greatest(0,work_m-coalesce(p.unpaid_break_minutes,0)); end if; end if;
      update public.timesheets set actual_checkin=new_in,actual_checkout=new_out,late_minutes=late_m,early_minutes=early_m,work_minutes=work_m,exception_codes=new_codes,source='ADJUSTED',status=case when new_in is not null and new_out is not null then 'APPROVED' else 'EXCEPTION' end,updated_at=now() where id=t.id returning * into t;
    else
      update public.timesheets set status='APPROVED',updated_at=now() where id=t.id returning * into t;
    end if;
  end if;
  insert into public.audit_logs(actor_employee_id,target_employee_id,action,entity_type,entity_id,reason,metadata) values(actor,r.employee_id,'ATTENDANCE_REQUEST_'||p_status,'attendance_request',r.id::text,p_note,jsonb_build_object('request_type',r.request_type,'timesheet_id',t.id));
  return jsonb_build_object('request',to_jsonb(r),'timesheet',to_jsonb(t));
end; $$;

create or replace function public.lock_timesheets_v2(p_through_date date)
returns integer language plpgsql security definer set search_path='' as $$
declare e public.employees%rowtype; c integer;
begin
  select * into e from public.employees where auth_user_id=auth.uid() and status='Active';
  if not found or e.role not in ('Admin','HR','Director') then raise exception 'Forbidden'; end if;
  update public.timesheets set status='LOCKED',locked_at=now(),locked_by=e.employee_id,updated_at=now() where work_date<=p_through_date and status in ('AUTO_APPROVED','APPROVED','COMPLETE');
  get diagnostics c=row_count;
  insert into public.audit_logs(actor_employee_id,action,entity_type,reason,metadata) values(e.employee_id,'TIMESHEETS_LOCKED','timesheet','Khóa kỳ công',jsonb_build_object('through_date',p_through_date,'count',c));
  return c;
end; $$;

create or replace function public.create_attendance_qr(p_center_id text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare operator_row public.employees%rowtype; location_row public.locations%rowtype; requested_center text; raw_token text; expiry timestamptz; expiry_ms bigint;
begin
  if auth.uid() is null then raise exception 'Vui lòng đăng nhập.'; end if;
  select * into operator_row from public.employees where auth_user_id=auth.uid() and status='Active';
  if not found then raise exception 'Không tìm thấy hồ sơ nhân viên.'; end if;
  if operator_row.role not in ('Admin','Director','HR','Kiosk') then raise exception 'Tài khoản không có quyền mở trạm QR.'; end if;
  requested_center:=coalesce(nullif(trim(p_center_id),''),operator_row.center_id);
  if operator_row.role<>'Admin' and requested_center<>operator_row.center_id and not(requested_center=any(coalesce(operator_row.allowed_locations,'{}'::text[]))) then raise exception 'Bạn chỉ được mở trạm QR tại chi nhánh đã gán.'; end if;
  select * into location_row from public.locations where center_id=requested_center and active; if not found then raise exception 'Chi nhánh chưa cấu hình vị trí.'; end if;
  insert into public.qr_stations(station_user_id,center_id,name,active,created_by,updated_at) values(auth.uid(),requested_center,'Trạm QR - '||location_row.center_name,true,operator_row.employee_id,now()) on conflict(station_user_id) do update set center_id=excluded.center_id,name=excluded.name,active=true,updated_at=now();
  raw_token:=translate(encode(extensions.gen_random_bytes(24),'base64'),E'+/\\\n','-_'); expiry:=clock_timestamp()+interval '45 seconds'; expiry_ms:=floor(extract(epoch from expiry)*1000);
  insert into public.attendance_qr_sessions(station_user_id,center_id,token_hash,created_by,issued_at,expires_at) values(auth.uid(),requested_center,encode(extensions.digest(raw_token,'sha256'),'hex'),operator_row.employee_id,clock_timestamp(),expiry) on conflict(station_user_id) do update set center_id=excluded.center_id,token_hash=excluded.token_hash,created_by=excluded.created_by,issued_at=excluded.issued_at,expires_at=excluded.expires_at;
  return jsonb_build_object('payload',jsonb_build_object('v',1,'s',auth.uid(),'c',requested_center,'t',raw_token,'e',expiry_ms)::text,'expiresAt',expiry_ms,'branchName',location_row.center_name);
end; $$;

grant execute on function public.get_my_tms_v2() to authenticated;
grant execute on function public.sync_my_timesheet_v2() to authenticated;
grant execute on function public.refresh_tms_exceptions_v2(date,date) to authenticated;
grant execute on function public.record_qr_attendance_v2(text,double precision,double precision,double precision,text) to authenticated;
grant execute on function public.submit_attendance_request_v2(uuid,text,text,timestamptz,timestamptz) to authenticated;
grant execute on function public.review_attendance_request_v2(uuid,text,text) to authenticated;
grant execute on function public.lock_timesheets_v2(date) to authenticated;
grant execute on function public.create_attendance_qr(text) to authenticated;
