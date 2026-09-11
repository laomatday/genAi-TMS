-- Vendored release: laomatday/genai-erp@f92cc58d9b54e3e50d382c42b25479212ac9b183
--
-- SECURITY/RELIABILITY FIX (2026-09-11): the original version of this migration fetched the
-- 7 files below over HTTPS from raw.githubusercontent.com/laomatday/genai-erp at apply time,
-- verifying each against a pinned git-blob SHA1 hash before executing it. That source repository
-- is no longer publicly reachable (confirmed via `curl` on 2026-09-11: HTTP 404 on both the repo
-- and the raw file URLs). A fresh database (disaster recovery, a new environment, CI) could
-- therefore no longer install this release at all.
--
-- This version inlines the exact same SQL, byte-for-byte, with no logic change. It was extracted
-- from wf_private.release_sources (archived by the original migration immediately after it
-- applied this release to production on 2026-09-05) and independently re-verified against the
-- same pinned git-blob SHA1 hashes shown in each section header below before being committed.
set local lock_timeout = '5s';
set local statement_timeout = '120s';

do $guard$
begin
  if to_regprocedure('public.workforce_query(text,jsonb)') is not null or to_regclass('public.organizations') is not null then
    raise exception 'Workforce release is already present or partially installed; inspect migration history before continuing.';
  end if;
  if to_regprocedure('public.refresh_tms_exceptions_v2(date,date)') is null then raise exception 'Required baseline RPC is missing'; end if;
  if exists(select 1 from public.attendance_requests) or exists(select 1 from public.leave_requests) or exists(select 1 from public.attendance_explanations) then
    raise exception 'Existing request data requires an explicit reviewed backfill before this release';
  end if;
end $guard$;

-- ============================================================================
-- database/releases/00_stability.sql  (git blob 70b1cade198ec8a89ec3bc21b0b8ac45a85f474e)
-- ============================================================================
-- Phase 0. Run through the release workflow, never through a browser client.
-- Back up automatically generated placeholders; never delete raw attendance evidence.
create schema if not exists wf_private;
revoke all on schema wf_private from public, anon, authenticated;
create table if not exists wf_private.upgrade_snapshots (
  release text not null,
  source_table text not null,
  source_id text not null,
  captured_at timestamptz not null default clock_timestamp(),
  reason text not null,
  row_data jsonb not null,
  primary key (release, source_table, source_id)
);
revoke all on wf_private.upgrade_snapshots from public, anon, authenticated;

-- A scheduled shift is not an active work session or a failed attendance attempt.
do $migration$
declare c record;
begin
  for c in select conname from pg_constraint
    where conrelid='public.timesheets'::regclass and contype='c'
      and pg_get_constraintdef(oid) like '%status%'
  loop execute format('alter table public.timesheets drop constraint %I', c.conname); end loop;
end $migration$;
alter table public.timesheets add constraint timesheets_status_check
  check (status in ('SCHEDULED','OPEN','COMPLETE','AUTO_APPROVED','EXCEPTION','PENDING_REVIEW','APPROVED','REJECTED','LOCKED','CANCELLED'));

insert into wf_private.upgrade_snapshots(release,source_table,source_id,reason,row_data)
select 'workforce-v3-phase0','timesheets',t.id::text,
  case when e.status='Inactive' then 'Archive inactive future placeholder' else 'Repair future placeholder status' end,
  to_jsonb(t)
from public.timesheets t join public.employees e using(employee_id)
where t.work_date > (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date
  and t.actual_checkin is null and t.actual_checkout is null
  and t.source='NORMAL' and t.status in ('EXCEPTION','OPEN')
  and not exists(select 1 from public.attendance_events x where x.timesheet_id=t.id)
  and not exists(select 1 from public.attendance_requests x where x.timesheet_id=t.id)
on conflict do nothing;

-- Keep inactive rows as CANCELLED, not hard-deleted. They are excluded from operational totals.
update public.timesheets t
set status=case when e.status='Inactive' then 'CANCELLED' else 'SCHEDULED' end,
    exception_codes='{}'::text[], updated_at=clock_timestamp()
from public.employees e
where e.employee_id=t.employee_id
  and t.work_date > (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date
  and t.actual_checkin is null and t.actual_checkout is null
  and t.source='NORMAL' and t.status in ('EXCEPTION','OPEN')
  and exists(select 1 from wf_private.upgrade_snapshots s
      where s.release='workforce-v3-phase0' and s.source_table='timesheets' and s.source_id=t.id::text)
  and not exists(select 1 from public.attendance_events x where x.timesheet_id=t.id)
  and not exists(select 1 from public.attendance_requests x where x.timesheet_id=t.id);

-- Preserve the existing implementation, but never let it generate future absences.
do $migration$
begin
  if to_regprocedure('wf_private.refresh_tms_exceptions_v2(date,date)') is null then
    alter function public.refresh_tms_exceptions_v2(date,date) set schema wf_private;
  end if;
end $migration$;
revoke all on function wf_private.refresh_tms_exceptions_v2(date,date) from public,anon,authenticated;
create or replace function public.refresh_tms_exceptions_v2(p_from date default null,p_to date default null)
returns integer language plpgsql security definer set search_path=''
as $function$
declare today date := (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date;
        first_day date; last_day date;
begin
  if not exists(select 1 from public.employees e where e.auth_user_id=(select auth.uid())
    and e.status='Active' and e.role in ('Admin','HR','Director')) then raise exception 'Forbidden' using errcode='42501'; end if;
  first_day := coalesce(p_from,today-31);
  last_day := least(coalesce(p_to,today),today);
  if p_from is not null and p_to is not null and p_from>p_to then raise exception 'Invalid date range'; end if;
  if first_day>last_day then return 0; end if;
  if last_day-first_day>366 then raise exception 'Date range exceeds 366 days'; end if;
  return wf_private.refresh_tms_exceptions_v2(first_day,last_day);
end $function$;
revoke all on function public.refresh_tms_exceptions_v2(date,date) from public,anon;
grant execute on function public.refresh_tms_exceptions_v2(date,date) to authenticated;

create or replace function wf_private.is_due(p_date date,p_expected timestamptz,p_now timestamptz)
returns boolean language sql immutable set search_path=''
as $$ select p_date <= (p_now at time zone 'Asia/Ho_Chi_Minh')::date and p_expected < p_now $$;
revoke all on function wf_private.is_due(date,timestamptz,timestamptz) from public,anon,authenticated;

-- ============================================================================
-- database/releases/00a_event_metadata.sql  (git blob ff10bcbb313524ab36d6be0ee0bebca5a29f9d17)
-- ============================================================================
-- Temporary, narrowly scoped schema-backfill guard. Run the complete release in ONE transaction.
-- Only adding a previously absent organization_id is allowed. Raw event fields stay immutable.
insert into wf_private.upgrade_snapshots(release,source_table,source_id,reason,row_data)
select 'workforce-v3-organization','attendance_events',id::text,'Organization metadata backfill',to_jsonb(e)
from public.attendance_events e on conflict do nothing;
create or replace function tms_private.prevent_attendance_event_mutation()
returns trigger language plpgsql set search_path='' as $$
begin
 if tg_op='UPDATE' and to_jsonb(old)->>'organization_id' is null and to_jsonb(new)->>'organization_id' is not null
   and (to_jsonb(old)-'organization_id')=(to_jsonb(new)-'organization_id')
   and exists(select 1 from wf_private.upgrade_snapshots s where s.release='workforce-v3-organization' and s.source_table='attendance_events' and s.source_id=old.id::text) then return new; end if;
 raise exception 'Raw attendance events are immutable.';
end $$;

-- ============================================================================
-- database/releases/01_workforce_core.sql  (git blob c9fa0c5a43024e26a844ba77b643cd9c5bd84f22)
-- ============================================================================
-- Workforce v3: organization boundary, capabilities, canonical attendance and receipts.
-- A single organization is initialized. This is NOT a self-service multi-tenant product.
create table public.organizations (
 id uuid primary key default extensions.gen_random_uuid(), code text not null unique,
 name text not null, timezone text not null default 'Asia/Ho_Chi_Minh', created_at timestamptz not null default now()
);
insert into public.organizations(code,name) values('genai','genAi');
create function wf_private.default_organization() returns uuid language sql stable security definer set search_path=''
as $$ select id from public.organizations where code='genai' $$;
revoke all on function wf_private.default_organization() from public,anon,authenticated;
alter table public.employees add column organization_id uuid references public.organizations(id);
update public.employees set organization_id=wf_private.default_organization();
alter table public.employees alter column organization_id set not null;
alter table public.employees alter column organization_id set default wf_private.default_organization();
alter table public.employees add column employment_start_date date;
alter table public.employees add column employment_end_date date;
update public.employees set employment_start_date=(created_at at time zone 'Asia/Ho_Chi_Minh')::date;

-- Derive ownership from the employee, not from a value submitted by the browser.
do $migration$
declare name text;
begin
 foreach name in array array['timesheets','attendance_events','attendance_requests','shift_assignments','trusted_devices'] loop
  execute format('alter table public.%I add column organization_id uuid references public.organizations(id)',name);
  execute format('update public.%I x set organization_id=e.organization_id from public.employees e where e.employee_id=x.employee_id',name);
  execute format('alter table public.%I alter column organization_id set not null',name);
 end loop;
 foreach name in array array['locations','attendance_policies','attendance_periods','qr_stations'] loop
  execute format('alter table public.%I add column organization_id uuid not null default wf_private.default_organization() references public.organizations(id)',name);
 end loop;
end $migration$;
create function wf_private.assign_organization() returns trigger language plpgsql security definer set search_path=''
as $$ begin
 select e.organization_id into new.organization_id from public.employees e where e.employee_id=new.employee_id;
 if new.organization_id is null then raise exception 'Unknown employee'; end if;
 return new;
end $$;
revoke all on function wf_private.assign_organization() from public,anon,authenticated;
do $migration$
declare name text;
begin foreach name in array array['timesheets','attendance_events','attendance_requests','shift_assignments','trusted_devices'] loop
 execute format('create trigger workforce_assign_organization before insert or update of employee_id,organization_id on public.%I for each row execute function wf_private.assign_organization()',name);
end loop; end $migration$;

create table public.workforce_role_capabilities (
 organization_id uuid not null references public.organizations(id), role text not null,
 capability text not null, enabled boolean not null default true,
 primary key(organization_id,role,capability)
);
create table public.workforce_employee_capabilities (
 organization_id uuid not null references public.organizations(id), employee_id text not null references public.employees(employee_id),
 capability text not null, enabled boolean not null, primary key(employee_id,capability)
);
insert into public.workforce_role_capabilities(organization_id,role,capability)
select o.id,r.role,c.capability from public.organizations o
cross join (values('Staff'),('Leader'),('Manager'),('Director'),('HR'),('Admin')) r(role)
cross join (values('attendance.self'),('request.submit'),('directory.read')) c(capability);
insert into public.workforce_role_capabilities(organization_id,role,capability)
select o.id,r.role,c.capability from public.organizations o
cross join (values('Leader'),('Manager'),('Director'),('HR'),('Admin')) r(role)
cross join (values('team.read'),('attendance.review')) c(capability);
insert into public.workforce_role_capabilities(organization_id,role,capability)
select o.id,r.role,c.capability from public.organizations o
cross join (values('Director'),('HR'),('Admin')) r(role)
cross join (values('schedule.manage'),('audit.view'),('attendance.export')) c(capability);
insert into public.workforce_role_capabilities(organization_id,role,capability)
select o.id,r.role,c.capability from public.organizations o
cross join (values('HR'),('Admin')) r(role)
cross join (values('team.read_all'),('attendance.lock_period'),('attendance.reopen_period'),('schedule.override')) c(capability);
insert into public.workforce_role_capabilities(organization_id,role,capability)
select o.id,'Admin',c.capability from public.organizations o
cross join (values('employee.manage'),('settings.manage'),('kiosk.manage'),('capability.manage')) c(capability);

create function wf_private.actor() returns public.employees language plpgsql stable security definer set search_path=''
as $$ declare e public.employees%rowtype; begin
 if (select auth.uid()) is null then raise exception 'Vui lòng đăng nhập.' using errcode='28000'; end if;
 select * into e from public.employees where auth_user_id=(select auth.uid()) and status='Active';
 if not found then raise exception 'Tài khoản không hoạt động.' using errcode='42501'; end if;
 return e;
end $$;
create function wf_private.capable(p_capability text) returns boolean language plpgsql stable security definer set search_path=''
as $$ declare a public.employees%rowtype; answer boolean; begin
 a:=wf_private.actor();
 select enabled into answer from public.workforce_employee_capabilities where employee_id=a.employee_id and organization_id=a.organization_id and capability=p_capability;
 if found then return answer; end if;
 return exists(select 1 from public.workforce_role_capabilities where organization_id=a.organization_id and role=a.role and capability=p_capability and enabled);
end $$;
create function wf_private.require_capability(p_capability text) returns public.employees language plpgsql stable security definer set search_path=''
as $$ begin if not wf_private.capable(p_capability) then raise exception 'Không có quyền thực hiện thao tác này.' using errcode='42501'; end if; return wf_private.actor(); end $$;
create function wf_private.in_scope(p_employee_id text) returns boolean language plpgsql stable security definer set search_path=''
as $$ declare a public.employees%rowtype; e public.employees%rowtype; begin
 a:=wf_private.actor(); select * into e from public.employees where employee_id=p_employee_id;
 if not found or e.organization_id<>a.organization_id then return false; end if;
 return e.employee_id=a.employee_id or (wf_private.capable('team.read') and
 (wf_private.capable('team.read_all') or e.direct_manager_id=a.employee_id or e.center_id=any(a.managed_locations)));
end $$;
create function wf_private.current_organization() returns uuid language plpgsql stable security definer set search_path=''
as $$ declare a public.employees%rowtype; begin a:=wf_private.actor(); return a.organization_id; end $$;
revoke all on all functions in schema wf_private from public,anon,authenticated;

alter table public.timesheets add column break_started_at timestamptz;
alter table public.timesheets add column break_minutes integer not null default 0 check(break_minutes>=0);
alter table public.timesheets add column revision bigint not null default 1;
alter table public.timesheets add column status_before_lock text;
alter table public.timesheets add column paid_leave_minutes integer not null default 0;
alter table public.attendance_events drop constraint attendance_events_event_type_check;
alter table public.attendance_events add constraint attendance_events_event_type_check check(event_type in ('CHECK_IN','CHECK_OUT','FAILED_ATTEMPT','PAUSE','RESUME','CORRECTION'));
create function wf_private.bump_revision() returns trigger language plpgsql set search_path=''
as $$ begin new.revision:=old.revision+1; new.updated_at:=clock_timestamp(); return new; end $$;
create trigger workforce_timesheet_revision before update on public.timesheets for each row execute function wf_private.bump_revision();

create table public.workforce_receipts (
 id uuid primary key default extensions.gen_random_uuid(), organization_id uuid not null references public.organizations(id),
 employee_id text not null references public.employees(employee_id), command_id uuid not null,
 action text not null, event_id uuid not null references public.attendance_events(id),
 payload jsonb not null, created_at timestamptz not null default clock_timestamp(), unique(employee_id,command_id)
);
create table public.workforce_notifications (
 id uuid primary key default extensions.gen_random_uuid(), organization_id uuid not null references public.organizations(id),
 employee_id text not null references public.employees(employee_id), dedupe_key text not null,
 kind text not null, title text not null, body text not null, context jsonb not null default '{}',
 created_at timestamptz not null default clock_timestamp(), read_at timestamptz, unique(employee_id,dedupe_key)
);
create index workforce_notifications_inbox on public.workforce_notifications(employee_id,created_at desc);
create table public.workforce_metrics (
 id bigint generated always as identity primary key, organization_id uuid not null references public.organizations(id),
 employee_id text references public.employees(employee_id), kind text not null,
 code text not null check(code ~ '^[A-Z0-9_]{2,48}$'), duration_ms integer check(duration_ms between 0 and 120000),
 created_at timestamptz not null default clock_timestamp()
);
create index workforce_metrics_window on public.workforce_metrics(organization_id,created_at desc);
create function wf_private.notify(p_employee text,p_key text,p_kind text,p_title text,p_body text,p_context jsonb default '{}')
returns void language sql security definer set search_path=''
as $$ insert into public.workforce_notifications(organization_id,employee_id,dedupe_key,kind,title,body,context)
 select organization_id,employee_id,left(p_key,200),left(p_kind,40),left(p_title,120),left(p_body,500),p_context from public.employees where employee_id=p_employee and status='Active'
 on conflict(employee_id,dedupe_key) do nothing $$;
create function wf_private.failure(p_code text,p_message text,p_details jsonb default '{}') returns jsonb language plpgsql security definer set search_path=''
as $$ declare a public.employees%rowtype; begin
 a:=wf_private.actor();
 insert into public.workforce_metrics(organization_id,employee_id,kind,code) values(a.organization_id,a.employee_id,'ATTENDANCE',p_code);
 return jsonb_build_object('ok',false,'code',p_code,'message',p_message,'details',p_details);
end $$;

-- Explicit action + idempotency key: retrying a check-in never becomes a check-out.
create function wf_private.attendance(p jsonb) returns jsonb language plpgsql security definer set search_path=''
as $function$
declare
 a public.employees%rowtype; pol public.attendance_policies%rowtype; loc public.locations%rowtype;
 sheet public.timesheets%rowtype; assignment public.shift_assignments%rowtype; shift public.config_shifts%rowtype;
 session public.attendance_qr_sessions%rowtype; existing public.workforce_receipts%rowtype;
 cmd uuid; act text:=p->>'action'; device text:=p->>'device_id'; qr jsonb;
 lat double precision:=(p->>'lat')::double precision; lng double precision:=(p->>'lng')::double precision;
 accuracy double precision:=(p->>'accuracy')::double precision; distance double precision;
 now_at timestamptz:=clock_timestamp(); day date:=(clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date;
 expected_start_at timestamptz; expected_end_at timestamptz; late_m integer:=0; early_m integer:=0;
 gross_m integer:=0; unpaid_m integer:=0; device_ok boolean:=false; codes text[]:='{}';
 event uuid; event_kind text; receipt uuid:=extensions.gen_random_uuid(); result jsonb; site text;
begin
 a:=wf_private.require_capability('attendance.self');
 cmd:=(p->>'command_id')::uuid;
 if cmd is null or act not in ('checkin','checkout','pause','resume') then raise exception 'Invalid attendance command'; end if;
 perform pg_advisory_xact_lock(hashtextextended('workforce:'||a.employee_id,0));
 select * into existing from public.workforce_receipts where employee_id=a.employee_id and command_id=cmd;
 if found then
  if existing.action<>act then raise exception 'Command ID was already used for a different action'; end if;
  return existing.payload;
 end if;
 select * into pol from public.attendance_policies where id=a.attendance_policy_id and active and organization_id=a.organization_id;
 if not found then return wf_private.failure('POLICY_MISSING','Chưa có chính sách chấm công. Liên hệ quản lý.'); end if;
 device_ok:=a.role='Admin' or exists(select 1 from public.trusted_device_grants g join public.trusted_devices td on td.device_id=g.device_id and td.employee_id=g.employee_id
  where g.employee_id=a.employee_id and g.device_id=device and g.expires_at>now_at and td.status='ACTIVE' and td.organization_id=a.organization_id);
 if not device_ok then return wf_private.failure('DEVICE_NOT_VERIFIED','Thiết bị chưa được xác thực. Đăng nhập lại hoặc liên hệ quản trị.'); end if;
 if lat is null or lng is null or lat not between -90 and 90 or lng not between -180 and 180 or accuracy is null or accuracy not between 0.1 and 10000 then
  return wf_private.failure('GPS_INVALID','Dữ liệu vị trí không hợp lệ. Bật quyền vị trí chính xác.'); end if;
 if accuracy>pol.gps_good_accuracy_m then return wf_private.failure(case when accuracy>pol.gps_max_accuracy_m then 'GPS_ACCURACY' else 'GPS_UNCERTAIN' end,
  'GPS chưa đủ chính xác. Giữ máy ổn định ở nơi thoáng và thử lại.',jsonb_build_object('accuracy',accuracy,'required_accuracy',pol.gps_good_accuracy_m)); end if;

 if act='checkin' then
  if exists(select 1 from public.timesheets where employee_id=a.employee_id and actual_checkin is not null and actual_checkout is null and status not in ('LOCKED','CANCELLED')) then
   return wf_private.failure('ALREADY_OPEN','Bạn còn ca chưa check-out. Hoàn tất ca đó trước.'); end if;
  select * into sheet from public.timesheets where employee_id=a.employee_id and work_date=day for update;
  if found and (sheet.actual_checkin is not null or sheet.status='LOCKED') then return wf_private.failure('ALREADY_COMPLETE','Ngày này đã có chấm công. Dùng yêu cầu điều chỉnh thay vì ghi đè.'); end if;
  begin qr:=(p->>'qr_payload')::jsonb; exception when others then return wf_private.failure('QR_INVALID','Mã QR không đúng định dạng.'); end;
  if qr is null or qr->>'v'<>'1' then return wf_private.failure('QR_INVALID','Quét mã tại trạm genAi.'); end if;
  begin select * into session from public.attendance_qr_sessions where station_user_id=(qr->>'s')::uuid;
  exception when others then return wf_private.failure('QR_INVALID','Mã QR không hợp lệ.'); end;
  if session.station_user_id is null or session.expires_at<=now_at or session.center_id is distinct from qr->>'c'
    or session.token_hash is distinct from encode(extensions.digest(coalesce(qr->>'t',''),'sha256'),'hex')
    or not exists(select 1 from public.qr_stations s where s.station_user_id=session.station_user_id and s.active and s.organization_id=a.organization_id) then
    return wf_private.failure('QR_EXPIRED','Mã QR đã đổi hoặc hết hạn. Quét lại mã mới.'); end if;
  site:=session.center_id;
 else
  select * into sheet from public.timesheets where employee_id=a.employee_id and actual_checkin is not null and actual_checkout is null and status not in ('LOCKED','CANCELLED') order by actual_checkin desc limit 1 for update;
  if not found then return wf_private.failure('NO_ACTIVE_SESSION','Không có ca đang mở.'); end if;
  day:=sheet.work_date; site:=sheet.location_id;
 end if;
 if exists(select 1 from public.attendance_periods ap where ap.organization_id=a.organization_id and ap.status='CLOSED' and day between ap.period_start and ap.period_end) then
  return wf_private.failure('PERIOD_LOCKED','Kỳ công đã khóa. Liên hệ HR để xử lý có kiểm soát.'); end if;
 select * into assignment from public.shift_assignments where employee_id=a.employee_id and work_date=day;
 if site<>a.center_id and not(site=any(coalesce(a.allowed_locations,'{}'))) and site is distinct from assignment.location_id then
  return wf_private.failure('LOCATION_NOT_ALLOWED','Bạn không được phân công tại địa điểm này.'); end if;
 select * into loc from public.locations where center_id=site and active and organization_id=a.organization_id;
 if not found then return wf_private.failure('LOCATION_MISSING','Địa điểm chưa được cấu hình.'); end if;
 distance:=tms_private.distance_meters(lat,lng,loc.latitude,loc.longitude);
 if distance>loc.radius_meters then return wf_private.failure('OUTSIDE_GEOFENCE','Bạn đang ở ngoài phạm vi chấm công.',jsonb_build_object('distance',round(distance::numeric),'radius',loc.radius_meters)); end if;

 if act='checkin' then
  expected_start_at:=((day+pol.expected_start) at time zone 'Asia/Ho_Chi_Minh');
  expected_end_at:=((day+pol.expected_end+case when pol.expected_end<=pol.expected_start then interval '1 day' else interval '0 days' end) at time zone 'Asia/Ho_Chi_Minh');
  if assignment.id is not null then
   select * into shift from public.config_shifts where id=assignment.shift_id and active;
   expected_start_at:=((day+shift.start_time) at time zone 'Asia/Ho_Chi_Minh');
   expected_end_at:=((day+shift.end_time+case when shift.end_time<=shift.start_time then interval '1 day' else interval '0 days' end) at time zone 'Asia/Ho_Chi_Minh');
  elsif not(extract(isodow from day)::smallint=any(pol.work_days)) then codes:=array_append(codes,'UNSCHEDULED_DAY'); end if;
  if now_at>expected_start_at+make_interval(mins=>pol.late_tolerance_minutes) then late_m:=floor(extract(epoch from(now_at-expected_start_at))/60)::integer; codes:=array_append(codes,'LATE'); end if;
  if now_at<expected_start_at+(pol.checkin_window_start-pol.expected_start) or now_at>expected_start_at+(pol.checkin_window_end-pol.expected_start) then codes:=array_append(codes,'OUTSIDE_CHECKIN_WINDOW'); end if;
  insert into public.timesheets(employee_id,work_date,policy_id,location_id,expected_start,expected_end,actual_checkin,status,source,exception_codes,late_minutes)
  values(a.employee_id,day,pol.id,site,expected_start_at,expected_end_at,now_at,'OPEN','NORMAL',codes,late_m)
  on conflict(employee_id,work_date) do update set policy_id=excluded.policy_id,location_id=excluded.location_id,expected_start=excluded.expected_start,expected_end=excluded.expected_end,
   actual_checkin=excluded.actual_checkin,status='OPEN',source='NORMAL',exception_codes=excluded.exception_codes,late_minutes=excluded.late_minutes
  returning * into sheet;
  event_kind:='CHECK_IN';
 elsif act='pause' then
  if sheet.break_started_at is not null then return wf_private.failure('ALREADY_PAUSED','Ca đang tạm dừng.'); end if;
  update public.timesheets set break_started_at=now_at where id=sheet.id returning * into sheet; event_kind:='PAUSE';
 elsif act='resume' then
  if sheet.break_started_at is null then return wf_private.failure('NOT_PAUSED','Ca hiện không tạm dừng.'); end if;
  update public.timesheets set break_minutes=break_minutes+greatest(0,floor(extract(epoch from(now_at-break_started_at))/60)::integer),break_started_at=null where id=sheet.id returning * into sheet; event_kind:='RESUME';
 else
  codes:=array_remove(coalesce(sheet.exception_codes,'{}'),'MISSING_CHECKOUT');
  if now_at<sheet.expected_end-make_interval(mins=>pol.early_tolerance_minutes) then early_m:=greatest(0,floor(extract(epoch from(sheet.expected_end-now_at))/60)::integer); codes:=array_append(codes,'EARLY_LEAVE'); end if;
  gross_m:=greatest(0,floor(extract(epoch from(now_at-sheet.actual_checkin))/60)::integer);
  unpaid_m:=sheet.break_minutes+case when sheet.break_started_at is null then 0 else greatest(0,floor(extract(epoch from(now_at-sheet.break_started_at))/60)::integer) end;
  unpaid_m:=greatest(unpaid_m,case when gross_m>=360 then pol.unpaid_break_minutes else 0 end);
  update public.timesheets set actual_checkout=now_at,early_minutes=early_m,work_minutes=greatest(0,gross_m-unpaid_m),break_started_at=null,break_minutes=unpaid_m,
   exception_codes=codes,status=case when cardinality(codes)>0 then 'EXCEPTION' when pol.auto_approve then 'AUTO_APPROVED' else 'COMPLETE' end
  where id=sheet.id returning * into sheet; event_kind:='CHECK_OUT';
 end if;
 insert into public.attendance_events(timesheet_id,employee_id,event_type,occurred_at,work_date,location_id,qr_station_id,latitude,longitude,gps_accuracy_m,distance_meters,gps_state,trusted_device_id,device_verified,outcome,validation)
 values(sheet.id,a.employee_id,event_kind,now_at,day,site,session.station_user_id,lat,lng,accuracy,distance,'VALID',device,device_ok,'VALID',jsonb_build_object('version',3,'command_id',cmd,'policy_id',pol.id,'qr_verified',act='checkin')) returning id into event;
 if act='checkin' then update public.timesheets set checkin_event_id=event where id=sheet.id; elsif act='checkout' then update public.timesheets set checkout_event_id=event where id=sheet.id; end if;
 result:=jsonb_build_object('ok',true,'receipt',jsonb_build_object('id',receipt,'event_id',event,'action',act,'occurred_at',now_at,'work_date',day,'location_name',loc.center_name,'gps_accuracy_m',accuracy,'device_verified',device_ok,'timesheet_id',sheet.id,'status',sheet.status));
 insert into public.workforce_receipts(id,organization_id,employee_id,command_id,action,event_id,payload) values(receipt,a.organization_id,a.employee_id,cmd,act,event,result);
 insert into public.workforce_metrics(organization_id,employee_id,kind,code,duration_ms) values(a.organization_id,a.employee_id,'ATTENDANCE','SUCCESS',least(120000,greatest(0,(extract(epoch from(clock_timestamp()-now_at))*1000)::integer)));
 return result;
end $function$;

-- New tables have no direct public write access. Only audited RPCs can modify them.
do $migration$
declare name text;
begin foreach name in array array['organizations','workforce_role_capabilities','workforce_employee_capabilities','workforce_receipts','workforce_notifications','workforce_metrics'] loop
 execute format('alter table public.%I enable row level security',name);
 execute format('revoke all on table public.%I from public,anon,authenticated',name);
end loop; end $migration$;
revoke all on all functions in schema wf_private from public,anon,authenticated;

-- ============================================================================
-- database/releases/01a_event_metadata_verified.sql  (git blob 1225b4605a0529b90b1ab0b898c479c0c0721f0d)
-- ============================================================================
-- Restore the original event immutability guard before any operational functions are exposed.
do $$ begin
 if exists(select 1 from wf_private.upgrade_snapshots s join public.attendance_events e on e.id::text=s.source_id
   where s.release='workforce-v3-organization' and s.source_table='attendance_events' and (to_jsonb(e)-'organization_id')<>s.row_data) then
  raise exception 'Event metadata migration changed raw evidence. Roll back the entire release.';
 end if;
 if exists(select 1 from wf_private.upgrade_snapshots s where s.release='workforce-v3-organization' and s.source_table='attendance_events'
  and not exists(select 1 from public.attendance_events e where e.id::text=s.source_id)) then raise exception 'Raw evidence was removed'; end if;
end $$;
create or replace function tms_private.prevent_attendance_event_mutation()
returns trigger language plpgsql set search_path='' as $$ begin raise exception 'Raw attendance events are immutable.'; end $$;

-- ============================================================================
-- database/releases/02_workforce_operations.sql  (git blob 8112daf19b5135791ed16433da53e3628fd008c4)
-- ============================================================================
-- Phase 1/2. One request centre, reviewer ownership/SLA, published schedules and payroll preparation.
alter table public.attendance_requests alter column timesheet_id drop not null;
alter table public.attendance_requests drop constraint attendance_requests_request_type_check;
alter table public.attendance_requests add constraint attendance_requests_request_type_check check(request_type in ('EXPLANATION','CORRECTION','ANNUAL_LEAVE','SICK_LEAVE','UNPAID_LEAVE','BUSINESS_TRIP','REMOTE_WORK','SHIFT_SWAP','OVERTIME'));
alter table public.attendance_requests drop constraint attendance_requests_status_check;
alter table public.attendance_requests add constraint attendance_requests_status_check check(status in ('PENDING','APPROVED','REJECTED','CANCELLED'));
alter table public.attendance_requests add column from_date date;
alter table public.attendance_requests add column to_date date;
alter table public.attendance_requests add column assigned_to text references public.employees(employee_id);
alter table public.attendance_requests add column fallback_to text references public.employees(employee_id);
alter table public.attendance_requests add column due_at timestamptz not null default (now()+interval '24 hours');
alter table public.attendance_requests add column escalated_at timestamptz;
alter table public.attendance_requests add column revision bigint not null default 1;
alter table public.attendance_requests add column workflow_data jsonb not null default '{}';
alter table public.attendance_requests add column legacy_source text;
alter table public.attendance_requests add column legacy_id text;
update public.attendance_requests r set from_date=t.work_date,to_date=t.work_date from public.timesheets t where t.id=r.timesheet_id;
update public.attendance_requests set from_date=(created_at at time zone 'Asia/Ho_Chi_Minh')::date,to_date=(created_at at time zone 'Asia/Ho_Chi_Minh')::date where from_date is null;
alter table public.attendance_requests alter column from_date set not null;
alter table public.attendance_requests alter column to_date set not null;
alter table public.attendance_requests add constraint workforce_request_dates check(from_date<=to_date and to_date-from_date<=366);
create unique index workforce_request_legacy on public.attendance_requests(legacy_source,legacy_id) where legacy_id is not null;
create index workforce_request_queue on public.attendance_requests(organization_id,status,due_at);
create trigger workforce_request_revision before update on public.attendance_requests for each row execute function wf_private.bump_revision();

alter table public.shift_assignments add column publication_status text not null default 'PUBLISHED' check(publication_status in ('DRAFT','PUBLISHED'));
alter table public.shift_assignments add column revision bigint not null default 1;
alter table public.shift_assignments add column published_at timestamptz;
alter table public.shift_assignments add column published_by text;
create trigger workforce_assignment_revision before update on public.shift_assignments for each row execute function wf_private.bump_revision();
create table public.workforce_schedule_templates (
 id uuid primary key default extensions.gen_random_uuid(),organization_id uuid not null references public.organizations(id),
 name text not null check(char_length(name) between 1 and 120),pattern jsonb not null check(jsonb_typeof(pattern)='array'),
 created_by text not null references public.employees(employee_id),created_at timestamptz not null default now(),unique(organization_id,name)
);
create table public.workforce_staffing_rules (
 organization_id uuid not null references public.organizations(id),location_id text not null references public.locations(center_id),
 shift_id bigint not null references public.config_shifts(id),weekday integer not null check(weekday between 1 and 7),
 minimum_people integer not null check(minimum_people between 1 and 500),primary key(organization_id,location_id,shift_id,weekday)
);
create table public.workforce_leave_ledger (
 id uuid primary key default extensions.gen_random_uuid(),organization_id uuid not null references public.organizations(id),
 employee_id text not null references public.employees(employee_id),request_id uuid not null unique references public.attendance_requests(id),
 days numeric not null check(days>=0),created_at timestamptz not null default now()
);
create table public.workforce_payroll_exports (
 id uuid primary key default extensions.gen_random_uuid(),organization_id uuid not null references public.organizations(id),
 period_start date not null,period_end date not null,created_by text not null references public.employees(employee_id),
 created_at timestamptz not null default now(),fingerprint text not null,payload jsonb not null,
 invalidated_at timestamptz,invalidated_reason text
);
create function wf_private.audit(p_action text,p_entity text,p_id text,p_reason text,p_metadata jsonb default '{}') returns void language plpgsql security definer set search_path=''
as $$ declare a public.employees%rowtype; begin a:=wf_private.actor();
 insert into public.audit_logs(actor_employee_id,action,entity_type,entity_id,reason,metadata)
 values(a.employee_id,p_action,p_entity,p_id,left(p_reason,1000),p_metadata||jsonb_build_object('organization_id',a.organization_id,'workforce_version',3));
end $$;

-- Draft assignments must not change a live employee's expected hours.
create or replace function tms_private.apply_assigned_shift_to_timesheet() returns trigger language plpgsql security definer set search_path=''
as $$ declare a public.shift_assignments%rowtype; s public.config_shifts%rowtype; begin
 select * into a from public.shift_assignments where employee_id=new.employee_id and work_date=new.work_date and publication_status='PUBLISHED';
 if found then
  select * into s from public.config_shifts where id=a.shift_id;
  new.expected_start:=((new.work_date+s.start_time) at time zone 'Asia/Ho_Chi_Minh');
  new.expected_end:=((new.work_date+s.end_time+case when s.end_time<=s.start_time then interval '1 day' else interval '0 days' end) at time zone 'Asia/Ho_Chi_Minh');
  new.location_id:=coalesce(a.location_id,new.location_id);
 end if; return new;
end $$;

create function wf_private.schedule_save(p jsonb) returns jsonb language plpgsql security definer set search_path=''
as $function$
declare a public.employees%rowtype; e public.employees%rowtype; s public.config_shifts%rowtype;
 old_row public.shift_assignments%rowtype; item jsonb; d date; site text; n integer:=0;
 start_at timestamptz; end_at timestamptz; why text:=trim(coalesce(p->>'override_reason','')); pub text;
begin
 a:=wf_private.require_capability('schedule.manage');
 if jsonb_typeof(p->'assignments')<>'array' or jsonb_array_length(p->'assignments') not between 1 and 500 then raise exception 'Cần từ 1 đến 500 lịch phân ca.'; end if;
 perform pg_advisory_xact_lock(hashtextextended('schedule:'||a.organization_id::text,0));
 for item in select value from jsonb_array_elements(p->'assignments') loop
  d:=(item->>'work_date')::date;
  if d is null or d<(clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date or d>(clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date+366 then raise exception 'Ngày phân ca phải từ hôm nay đến một năm tới.'; end if;
  if not wf_private.in_scope(item->>'employee_id') then raise exception 'Nhân viên ngoài phạm vi quản lý.' using errcode='42501'; end if;
  select * into e from public.employees where employee_id=item->>'employee_id' and status='Active' and role<>'Kiosk';
  if not found then raise exception 'Nhân viên không hoạt động.'; end if;
  select * into s from public.config_shifts where id=(item->>'shift_id')::bigint and active;
  if not found then raise exception 'Ca làm không hợp lệ.'; end if;
  site:=coalesce(nullif(item->>'location_id',''),e.center_id);
  if not exists(select 1 from public.locations where center_id=site and active and organization_id=a.organization_id) then raise exception 'Địa điểm không hợp lệ.'; end if;
  if site<>e.center_id and not(site=any(e.allowed_locations)) then raise exception 'Nhân viên chưa được cấp quyền cho địa điểm này.'; end if;
  if exists(select 1 from public.attendance_periods where organization_id=a.organization_id and status='CLOSED' and d between period_start and period_end) then raise exception 'Kỳ công đã khóa.'; end if;
  if exists(select 1 from public.timesheets where employee_id=e.employee_id and work_date=d and (actual_checkin is not null or status='LOCKED')) then raise exception 'Ca đã có chấm công; không được thay lịch.'; end if;
  start_at:=((d+s.start_time) at time zone 'Asia/Ho_Chi_Minh');
  end_at:=((d+s.end_time+case when s.end_time<=s.start_time then interval '1 day' else interval '0 day' end) at time zone 'Asia/Ho_Chi_Minh');
  if end_at-start_at>interval '12 hours' then raise exception 'Ca vượt ngưỡng vận hành 12 giờ. Kiểm tra cấu hình ca.'; end if;
  if exists(select 1 from public.shift_assignments sa join public.config_shifts cs on cs.id=sa.shift_id
    where sa.employee_id=e.employee_id and sa.work_date<>d and sa.work_date between d-1 and d+1
    and tstzrange((sa.work_date+cs.start_time) at time zone 'Asia/Ho_Chi_Minh',
     (sa.work_date+cs.end_time+case when cs.end_time<=cs.start_time then interval '1 day' else interval '0 days' end) at time zone 'Asia/Ho_Chi_Minh','[)') && tstzrange(start_at,end_at,'[)')) then raise exception 'Ca bị trùng thời gian với lịch liền kề.'; end if;
  select * into old_row from public.shift_assignments where employee_id=e.employee_id and work_date=d for update;
  if found then
   if coalesce((item->>'revision')::bigint,0)<>old_row.revision then raise exception 'Lịch đã thay đổi. Tải lại trước khi sửa.' using errcode='40001'; end if;
   if old_row.publication_status='PUBLISHED' and (length(why)<5 or not wf_private.capable('schedule.override')) then raise exception 'Lịch đã công bố. Cần quyền sửa lịch và lý do.'; end if;
   pub:=old_row.publication_status;
  else pub:='DRAFT'; end if;
  insert into public.shift_assignments(employee_id,work_date,shift_id,location_id,note,created_by,publication_status)
  values(e.employee_id,d,s.id,site,left(coalesce(item->>'note',''),500),a.employee_id,pub)
  on conflict(employee_id,work_date) do update set shift_id=excluded.shift_id,location_id=excluded.location_id,note=excluded.note,created_by=excluded.created_by;
  if pub='PUBLISHED' then
   update public.timesheets set expected_start=start_at,expected_end=end_at,location_id=site where employee_id=e.employee_id and work_date=d and actual_checkin is null and status not in ('LOCKED','APPROVED','PENDING_REVIEW');
   perform wf_private.notify(e.employee_id,'schedule-change:'||d::text||':'||clock_timestamp()::text,'SCHEDULE_CHANGED','Lịch làm việc đã thay đổi',d::text||' · '||s.name,jsonb_build_object('date',d));
  end if;
  n:=n+1;
 end loop;
 perform wf_private.audit('SCHEDULE_SAVED','shift_assignment',null,coalesce(nullif(why,''),'Lập lịch nháp'),jsonb_build_object('count',n));
 return jsonb_build_object('ok',true,'count',n);
end $function$;

create function wf_private.schedule_command(p_action text,p jsonb) returns jsonb language plpgsql security definer set search_path=''
as $function$
declare a public.employees%rowtype; sa public.shift_assignments%rowtype; s public.config_shifts%rowtype;
 first_day date; last_day date; source_day date; target_day date; entries jsonb; pattern jsonb; entry jsonb;
 template public.workforce_schedule_templates%rowtype; employee text; w integer; weeks integer; n integer:=0;
begin
 a:=wf_private.require_capability('schedule.manage');
 if p_action='schedule.save' then return wf_private.schedule_save(p); end if;
 if p_action='schedule.template_save' then
  if length(trim(coalesce(p->>'name',''))) not between 1 and 120 or jsonb_typeof(p->'pattern')<>'array' or jsonb_array_length(p->'pattern') not between 1 and 7 then raise exception 'Mẫu cần tên và 1–7 ngày trong tuần.'; end if;
  for entry in select value from jsonb_array_elements(p->'pattern') loop
   if (entry->>'weekday')::integer not between 1 and 7 or not exists(select 1 from public.config_shifts where id=(entry->>'shift_id')::bigint and active) then raise exception 'Ngày hoặc ca trong mẫu không hợp lệ.'; end if;
  end loop;
  insert into public.workforce_schedule_templates(organization_id,name,pattern,created_by) values(a.organization_id,trim(p->>'name'),p->'pattern',a.employee_id) returning * into template;
  perform wf_private.audit('SCHEDULE_TEMPLATE_CREATED','schedule_template',template.id::text,template.name);
  return jsonb_build_object('ok',true,'id',template.id);
 end if;
 if p_action in ('schedule.copy_week','schedule.repeat') then
  target_day:=(p->>'target_start')::date;
  if target_day is null or target_day<(clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date then raise exception 'Tuần đích phải bắt đầu từ hôm nay trở đi.'; end if;
  entries:='[]'::jsonb;
  if p_action='schedule.copy_week' then
   source_day:=(p->>'source_start')::date;
   select coalesce(jsonb_agg(jsonb_build_object('employee_id',x.employee_id,'work_date',target_day+(x.work_date-source_day),'shift_id',x.shift_id,'location_id',x.location_id,'note','Sao chép tuần')),'[]') into entries
   from public.shift_assignments x join public.employees e using(employee_id)
   where x.organization_id=a.organization_id and x.work_date between source_day and source_day+6 and e.status='Active' and wf_private.in_scope(x.employee_id);
  else
   weeks:=coalesce((p->>'weeks')::integer,1);
   if weeks not between 1 and 8 or jsonb_typeof(p->'employees')<>'array' or jsonb_array_length(p->'employees') not between 1 and 100 then raise exception 'Giới hạn 1–8 tuần, 1–100 nhân viên và 500 lịch mỗi lần.'; end if;
   select * into template from public.workforce_schedule_templates where id=(p->>'template_id')::uuid and organization_id=a.organization_id;
   if not found then raise exception 'Không tìm thấy mẫu lịch.'; end if;
   pattern:=template.pattern;
   for employee in select jsonb_array_elements_text(p->'employees') loop
    for w in 0..weeks-1 loop
     for entry in select value from jsonb_array_elements(pattern) loop
      entries:=entries||jsonb_build_array(jsonb_build_object('employee_id',employee,'work_date',target_day+w*7+((entry->>'weekday')::integer-1),'shift_id',(entry->>'shift_id')::bigint,'location_id',entry->>'location_id','note',template.name));
     end loop;
    end loop;
   end loop;
  end if;
  return wf_private.schedule_save(jsonb_build_object('assignments',entries));
 end if;
 if p_action='schedule.coverage' then
  if not exists(select 1 from public.locations where center_id=p->>'location_id' and organization_id=a.organization_id and active) then raise exception 'Địa điểm không hợp lệ.'; end if;
  if not wf_private.capable('team.read_all') and not((p->>'location_id')=any(a.managed_locations)) then raise exception 'Địa điểm ngoài phạm vi.' using errcode='42501'; end if;
  insert into public.workforce_staffing_rules(organization_id,location_id,shift_id,weekday,minimum_people)
  values(a.organization_id,p->>'location_id',(p->>'shift_id')::bigint,(p->>'weekday')::integer,(p->>'minimum_people')::integer)
  on conflict(organization_id,location_id,shift_id,weekday) do update set minimum_people=excluded.minimum_people;
  perform wf_private.audit('STAFFING_RULE_SAVED','staffing_rule',p->>'location_id','Cấu hình số người tối thiểu');
  return jsonb_build_object('ok',true);
 end if;
 if p_action='schedule.publish' then
  first_day:=(p->>'from')::date; last_day:=(p->>'to')::date;
  if first_day is null or last_day is null or first_day>last_day or last_day-first_day>62 or first_day<(clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date then raise exception 'Khoảng công bố không hợp lệ.'; end if;
  perform pg_advisory_xact_lock(hashtextextended('schedule:'||a.organization_id::text,0));
  for sa in select x.* from public.shift_assignments x join public.employees e using(employee_id)
   where x.organization_id=a.organization_id and x.work_date between first_day and last_day and x.publication_status='DRAFT' and e.status='Active' and wf_private.in_scope(x.employee_id) order by x.id for update of x loop
   if exists(select 1 from public.timesheets where employee_id=sa.employee_id and work_date=sa.work_date and (actual_checkin is not null or status='LOCKED')) then raise exception 'Có ca đã phát sinh dữ liệu, chưa thể công bố.'; end if;
   select * into s from public.config_shifts where id=sa.shift_id and active;
   if not found then raise exception 'Ca không còn hoạt động.'; end if;
   update public.shift_assignments set publication_status='PUBLISHED',published_at=clock_timestamp(),published_by=a.employee_id where id=sa.id;
   insert into public.timesheets(employee_id,work_date,policy_id,location_id,expected_start,expected_end,status)
   select e.employee_id,sa.work_date,e.attendance_policy_id,sa.location_id,
    (sa.work_date+s.start_time) at time zone 'Asia/Ho_Chi_Minh',
    (sa.work_date+s.end_time+case when s.end_time<=s.start_time then interval '1 day' else interval '0 days' end) at time zone 'Asia/Ho_Chi_Minh','SCHEDULED'
   from public.employees e where e.employee_id=sa.employee_id
   on conflict(employee_id,work_date) do update set expected_start=excluded.expected_start,expected_end=excluded.expected_end,location_id=excluded.location_id,status='SCHEDULED',exception_codes='{}'
   where timesheets.actual_checkin is null and timesheets.status not in ('LOCKED','APPROVED','PENDING_REVIEW');
   perform wf_private.notify(sa.employee_id,'publish:'||sa.id::text||':'||sa.revision::text,'SCHEDULE_CHANGED','Đã công bố lịch làm việc',sa.work_date::text||' · '||s.name,jsonb_build_object('date',sa.work_date)); n:=n+1;
  end loop;
  perform wf_private.audit('SCHEDULE_PUBLISHED','shift_assignment',null,'Công bố lịch',jsonb_build_object('from',first_day,'to',last_day,'count',n));
  return jsonb_build_object('ok',true,'count',n);
 end if;
 if p_action='schedule.delete' then
  select * into sa from public.shift_assignments where id=(p->>'id')::uuid for update;
  if not found or not wf_private.in_scope(sa.employee_id) then raise exception 'Không tìm thấy lịch trong phạm vi.' using errcode='42501'; end if;
  if sa.revision<>coalesce((p->>'revision')::bigint,0) then raise exception 'Lịch đã thay đổi. Tải lại.' using errcode='40001'; end if;
  if sa.publication_status='PUBLISHED' then raise exception 'Không xóa lịch đã công bố. Sửa lịch với lý do hoặc gửi yêu cầu đổi ca.'; end if;
  delete from public.shift_assignments where id=sa.id;
  perform wf_private.audit('SCHEDULE_DRAFT_DELETED','shift_assignment',sa.id::text,'Xóa lịch nháp',to_jsonb(sa));
  return jsonb_build_object('ok',true);
 end if;
 raise exception 'Unknown schedule action';
end $function$;

create function wf_private.submit_request(p jsonb) returns jsonb language plpgsql security definer set search_path=''
as $function$
declare a public.employees%rowtype; r public.attendance_requests%rowtype; t public.timesheets%rowtype;
 owner_id text; backup_id text; first_day date:=(p->>'from_date')::date; last_day date:=coalesce((p->>'to_date')::date,(p->>'from_date')::date);
 kind text:=p->>'request_type'; why text:=trim(coalesce(p->>'reason','')); detail jsonb:='{}';
 sa public.shift_assignments%rowtype; peer public.shift_assignments%rowtype;
begin
 a:=wf_private.require_capability('request.submit');
 if kind not in ('EXPLANATION','CORRECTION','ANNUAL_LEAVE','SICK_LEAVE','UNPAID_LEAVE','BUSINESS_TRIP','REMOTE_WORK','SHIFT_SWAP','OVERTIME') or length(why) not between 5 and 1000 then raise exception 'Chọn loại yêu cầu và nhập lý do từ 5 đến 1.000 ký tự.'; end if;
 if first_day is null or last_day<first_day or last_day-first_day>366 then raise exception 'Khoảng ngày không hợp lệ.'; end if;
 if first_day<(clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date-45 or last_day>(clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date+366 then raise exception 'Ngày yêu cầu ngoài phạm vi cho phép.'; end if;
 if exists(select 1 from public.attendance_periods where organization_id=a.organization_id and status='CLOSED' and daterange(period_start,period_end,'[]') && daterange(first_day,last_day,'[]')) then raise exception 'Yêu cầu liên quan kỳ công đã khóa.'; end if;
 if exists(select 1 from public.attendance_requests where employee_id=a.employee_id and status='PENDING' and request_type=kind and daterange(from_date,to_date,'[]') && daterange(first_day,last_day,'[]')) then raise exception 'Đã có yêu cầu tương tự đang chờ duyệt.'; end if;
 select e.employee_id into owner_id from public.employees e where e.employee_id=a.direct_manager_id and e.status='Active' and e.organization_id=a.organization_id and e.employee_id<>a.employee_id and e.role in ('Leader','Manager','Director','HR','Admin');
 select e.employee_id into backup_id from public.employees e where e.organization_id=a.organization_id and e.status='Active' and e.employee_id<>a.employee_id and e.role in ('HR','Admin') and e.employee_id is distinct from owner_id order by case when e.role='HR' then 0 else 1 end,e.employee_id limit 1;
 owner_id:=coalesce(owner_id,backup_id);
 if kind in ('EXPLANATION','CORRECTION') then
  if first_day<>last_day or first_day>(clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date then raise exception 'Chỉ điều chỉnh một ngày đã xảy ra.'; end if;
  select * into t from public.timesheets where employee_id=a.employee_id and work_date=first_day for update;
  if not found then raise exception 'Chưa có bảng công cho ngày này. Quản lý cần đối soát trước.'; end if;
  if t.status='LOCKED' then raise exception 'Ngày công đã khóa.'; end if;
  if kind='CORRECTION' and p->>'requested_checkin' is null and p->>'requested_checkout' is null then raise exception 'Điều chỉnh cần có giờ đề nghị.'; end if;
  detail:=jsonb_build_object('previous_status',t.status);
 end if;
 if kind='OVERTIME' then
  if first_day<>last_day or p->>'requested_checkin' is null or p->>'requested_checkout' is null or (p->>'requested_checkout')::timestamptz<=(p->>'requested_checkin')::timestamptz or (p->>'requested_checkout')::timestamptz-(p->>'requested_checkin')::timestamptz>interval '8 hours' then raise exception 'Đăng ký tăng ca cần giờ bắt đầu/kết thúc hợp lệ, tối đa 8 giờ.'; end if;
 end if;
 if kind='SHIFT_SWAP' then
  select * into sa from public.shift_assignments where employee_id=a.employee_id and work_date=first_day and publication_status='PUBLISHED';
  select * into peer from public.shift_assignments where employee_id=p->>'peer_employee_id' and employee_id<>a.employee_id and work_date=first_day and publication_status='PUBLISHED' and organization_id=a.organization_id;
  if sa.id is null or peer.id is null or first_day<(clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date then raise exception 'Đổi ca cần hai lịch đã công bố trong cùng ngày, chưa diễn ra.'; end if;
  detail:=jsonb_build_object('peer_employee_id',peer.employee_id,'source_id',sa.id,'peer_id',peer.id,'source_revision',sa.revision,'peer_revision',peer.revision,'peer_accepted',false);
 end if;
 insert into public.attendance_requests(timesheet_id,employee_id,request_type,reason,status,from_date,to_date,requested_checkin,requested_checkout,assigned_to,fallback_to,workflow_data)
 values(t.id,a.employee_id,kind,why,'PENDING',first_day,last_day,(p->>'requested_checkin')::timestamptz,(p->>'requested_checkout')::timestamptz,owner_id,backup_id,detail) returning * into r;
 if t.id is not null then update public.timesheets set status='PENDING_REVIEW' where id=t.id; end if;
 perform wf_private.notify(owner_id,'request:'||r.id::text,'REQUEST_PENDING','Có yêu cầu cần duyệt',a.name||' · '||first_day::text,jsonb_build_object('request_id',r.id));
 if kind='SHIFT_SWAP' then perform wf_private.notify(detail->>'peer_employee_id','swap:'||r.id::text,'SWAP_CONSENT','Có đề nghị đổi ca',a.name||' đề nghị đổi ca ngày '||first_day::text,jsonb_build_object('request_id',r.id)); end if;
 perform wf_private.audit('REQUEST_SUBMITTED','attendance_request',r.id::text,why,jsonb_build_object('type',kind,'assigned_to',owner_id));
 return jsonb_build_object('ok',true,'request',to_jsonb(r));
end $function$;

create function wf_private.review_request(p jsonb) returns jsonb language plpgsql security definer set search_path=''
as $function$
declare a public.employees%rowtype; r public.attendance_requests%rowtype; e public.employees%rowtype; t public.timesheets%rowtype;
 pol public.attendance_policies%rowtype; sa public.shift_assignments%rowtype; peer public.shift_assignments%rowtype;
 decision text:=p->>'decision'; why text:=trim(coalesce(p->>'note','')); days integer:=0; start_at timestamptz; end_at timestamptz; unpaid integer:=0;
begin
 a:=wf_private.require_capability('attendance.review');
 if decision not in ('APPROVED','REJECTED') then raise exception 'Quyết định không hợp lệ.'; end if;
 select * into r from public.attendance_requests where id=(p->>'id')::uuid for update;
 if not found or not wf_private.in_scope(r.employee_id) then raise exception 'Yêu cầu ngoài phạm vi.' using errcode='42501'; end if;
 if r.employee_id=a.employee_id then raise exception 'Không được tự duyệt yêu cầu của mình.' using errcode='42501'; end if;
 if r.status<>'PENDING' or r.revision<>coalesce((p->>'revision')::bigint,0) then raise exception 'Yêu cầu đã thay đổi. Tải lại.' using errcode='40001'; end if;
 if r.assigned_to is distinct from a.employee_id and not(r.fallback_to=a.employee_id and r.due_at<clock_timestamp())
  and not(wf_private.capable('team.read_all') and length(why)>=5) then raise exception 'Bạn không phải người phụ trách. Cần ghi lý do khi duyệt thay.' using errcode='42501'; end if;
 if decision='REJECTED' and length(why)<5 then raise exception 'Từ chối phải có lý do ít nhất 5 ký tự.'; end if;
 if exists(select 1 from public.attendance_periods where organization_id=a.organization_id and status='CLOSED' and daterange(period_start,period_end,'[]')&&daterange(r.from_date,r.to_date,'[]')) then raise exception 'Kỳ công đã khóa.'; end if;
 select * into e from public.employees where employee_id=r.employee_id for update;
 select * into pol from public.attendance_policies where id=e.attendance_policy_id;
 if decision='APPROVED' then
  if r.request_type='ANNUAL_LEAVE' then
   select count(*) into days from generate_series(r.from_date,r.to_date,interval '1 day') g
   where (extract(isodow from g)::smallint=any(pol.work_days) or exists(select 1 from public.shift_assignments x where x.employee_id=e.employee_id and x.work_date=g::date and x.publication_status='PUBLISHED'))
   and not exists(select 1 from public.holidays h where h.active and g::date between h.from_date and h.to_date);
   if days<=0 then raise exception 'Khoảng nghỉ không có ngày làm việc.'; end if;
   if coalesce(e.annual_leave_balance,0)<days then raise exception 'Quỹ phép không đủ.'; end if;
   if exists(select 1 from public.attendance_requests x where x.employee_id=e.employee_id and x.id<>r.id and x.status='APPROVED' and x.request_type in ('ANNUAL_LEAVE','SICK_LEAVE','UNPAID_LEAVE') and daterange(x.from_date,x.to_date,'[]')&&daterange(r.from_date,r.to_date,'[]')) then raise exception 'Trùng khoảng nghỉ đã duyệt.'; end if;
   insert into public.workforce_leave_ledger(organization_id,employee_id,request_id,days) values(a.organization_id,e.employee_id,r.id,days);
   update public.employees set annual_leave_balance=annual_leave_balance-days where employee_id=e.employee_id;
  elsif r.request_type in ('EXPLANATION','CORRECTION') then
   select * into t from public.timesheets where id=r.timesheet_id for update;
   if t.status='LOCKED' then raise exception 'Ngày công đã khóa.'; end if;
   start_at:=coalesce(r.requested_checkin,t.actual_checkin); end_at:=coalesce(r.requested_checkout,t.actual_checkout);
   if start_at is null or end_at is null or end_at<=start_at or end_at-start_at>interval '24 hours' or (start_at at time zone 'Asia/Ho_Chi_Minh')::date<>t.work_date or end_at>clock_timestamp() then raise exception 'Thiếu giờ thực tế hợp lệ. Cần yêu cầu điều chỉnh, không tự quy đủ công từ giải trình.'; end if;
   unpaid:=greatest(t.break_minutes,case when end_at-start_at>=interval '6 hours' then coalesce(pol.unpaid_break_minutes,0) else 0 end);
   perform wf_private.audit('TIMESHEET_BEFORE_CORRECTION','timesheet',t.id::text,why,to_jsonb(t));
   update public.timesheets set actual_checkin=start_at,actual_checkout=end_at,source=case when r.request_type='CORRECTION' then 'ADJUSTED' else source end,
    work_minutes=greatest(0,floor(extract(epoch from(end_at-start_at))/60)::integer-unpaid),status='APPROVED'
   where id=t.id;
   if r.request_type='CORRECTION' then insert into public.attendance_events(timesheet_id,employee_id,event_type,work_date,location_id,outcome,validation)
    values(t.id,e.employee_id,'CORRECTION',t.work_date,t.location_id,'VALID',jsonb_build_object('request_id',r.id,'approver',a.employee_id,'requested_checkin',start_at,'requested_checkout',end_at)); end if;
  elsif r.request_type='SHIFT_SWAP' then
   if coalesce((r.workflow_data->>'peer_accepted')::boolean,false)=false then raise exception 'Đồng nghiệp chưa xác nhận đổi ca.'; end if;
   perform pg_advisory_xact_lock(hashtextextended('schedule:'||a.organization_id::text,0));
   select * into sa from public.shift_assignments where id=(r.workflow_data->>'source_id')::uuid for update;
   select * into peer from public.shift_assignments where id=(r.workflow_data->>'peer_id')::uuid for update;
   if sa.id is null or peer.id is null or sa.revision<>(r.workflow_data->>'source_revision')::bigint or peer.revision<>(r.workflow_data->>'peer_revision')::bigint then raise exception 'Lịch đã thay đổi sau khi gửi đề nghị.'; end if;
   if not wf_private.in_scope(peer.employee_id) then raise exception 'Người đổi ca ngoài phạm vi duyệt.' using errcode='42501'; end if;
   -- Reuse exactly the same conflict, location, date and publication checks as manual scheduling.
   perform wf_private.schedule_save(jsonb_build_object('override_reason','Đổi ca đã được hai nhân viên xác nhận', 'assignments',jsonb_build_array(
    jsonb_build_object('employee_id',sa.employee_id,'work_date',sa.work_date,'shift_id',peer.shift_id,'location_id',peer.location_id,'revision',sa.revision),
    jsonb_build_object('employee_id',peer.employee_id,'work_date',peer.work_date,'shift_id',sa.shift_id,'location_id',sa.location_id,'revision',peer.revision))));
  end if;
 elsif r.timesheet_id is not null then update public.timesheets set status=coalesce(nullif(r.workflow_data->>'previous_status',''),'EXCEPTION') where id=r.timesheet_id and status='PENDING_REVIEW'; end if;
 update public.attendance_requests set status=decision,manager_note=why,approver_id=a.employee_id where id=r.id;
 perform wf_private.notify(r.employee_id,'decision:'||r.id::text,'REQUEST_DECIDED',case when decision='APPROVED' then 'Yêu cầu đã được duyệt' else 'Yêu cầu bị từ chối' end,coalesce(nullif(why,''),'Mở trung tâm yêu cầu để xem chi tiết.'),jsonb_build_object('request_id',r.id));
 perform wf_private.audit('REQUEST_'||decision,'attendance_request',r.id::text,why,jsonb_build_object('employee_id',r.employee_id,'type',r.request_type));
 return jsonb_build_object('ok',true);
end $function$;

create function wf_private.request_command(p_action text,p jsonb) returns jsonb language plpgsql security definer set search_path=''
as $$ declare a public.employees%rowtype; r public.attendance_requests%rowtype; entry jsonb; n integer:=0; begin
 a:=wf_private.actor();
 if p_action='request.submit' then return wf_private.submit_request(p); end if;
 if p_action='request.review' then return wf_private.review_request(p); end if;
 if p_action='request.review_many' then
  if jsonb_typeof(p->'requests')<>'array' or jsonb_array_length(p->'requests') not between 1 and 100 then raise exception 'Chọn 1–100 yêu cầu.'; end if;
  for entry in select value from jsonb_array_elements(p->'requests') order by value->>'id' loop
   perform wf_private.review_request(entry||jsonb_build_object('decision',p->>'decision','note',p->>'note')); n:=n+1;
  end loop; return jsonb_build_object('ok',true,'count',n);
 end if;
 select * into r from public.attendance_requests where id=(p->>'id')::uuid for update;
 if not found or r.organization_id<>a.organization_id then raise exception 'Không tìm thấy yêu cầu.' using errcode='42501'; end if;
 if r.status<>'PENDING' or r.revision<>coalesce((p->>'revision')::bigint,0) then raise exception 'Yêu cầu đã thay đổi. Tải lại.' using errcode='40001'; end if;
 if p_action='request.cancel' then
  if r.employee_id<>a.employee_id then raise exception 'Chỉ hủy yêu cầu của mình.' using errcode='42501'; end if;
  update public.attendance_requests set status='CANCELLED' where id=r.id;
  if r.timesheet_id is not null then update public.timesheets set status=coalesce(nullif(r.workflow_data->>'previous_status',''),'EXCEPTION') where id=r.timesheet_id and status='PENDING_REVIEW'; end if;
 elsif p_action='request.respond_swap' then
  if r.request_type<>'SHIFT_SWAP' or r.workflow_data->>'peer_employee_id'<>a.employee_id then raise exception 'Không có quyền xác nhận đề nghị này.' using errcode='42501'; end if;
  update public.attendance_requests set workflow_data=workflow_data||jsonb_build_object('peer_accepted',coalesce((p->>'accepted')::boolean,false),'peer_responded_at',clock_timestamp()),
   status=case when coalesce((p->>'accepted')::boolean,false) then 'PENDING' else 'CANCELLED' end where id=r.id;
 else raise exception 'Unknown request action'; end if;
 perform wf_private.audit(upper(replace(p_action,'.','_')),'attendance_request',r.id::text,'Nhân viên cập nhật yêu cầu');
 return jsonb_build_object('ok',true);
end $$;

do $migration$ declare name text; begin
 foreach name in array array['workforce_schedule_templates','workforce_staffing_rules','workforce_leave_ledger','workforce_payroll_exports'] loop
  execute format('alter table public.%I enable row level security',name);
  execute format('revoke all on table public.%I from public,anon,authenticated',name);
 end loop;
end $migration$;
revoke all on all functions in schema wf_private from public,anon,authenticated;

-- ============================================================================
-- database/releases/03_maintenance_payroll.sql  (git blob 2d0c58432ba972c20f3e665f0c2afb6f248e7f79)
-- ============================================================================
-- Phase 2/3. Maintenance is explicit or scheduled, never a side effect of opening a dashboard.
create function wf_private.scope_ids() returns setof text language plpgsql stable security definer set search_path=''
as $$ declare a public.employees%rowtype; team boolean; all_rows boolean; begin
 a:=wf_private.actor(); team:=wf_private.capable('team.read'); all_rows:=wf_private.capable('team.read_all');
 return query select e.employee_id from public.employees e where e.organization_id=a.organization_id and
 (e.employee_id=a.employee_id or (team and (all_rows or e.direct_manager_id=a.employee_id or e.center_id=any(a.managed_locations))));
end $$;
create function wf_private.period_lock(p_org uuid,p_first date,p_last date,p_exclusive boolean default false)
returns void language plpgsql set search_path=''
as $$ declare m timestamptz; key bigint; begin
 if p_first is null or p_last is null or p_first>p_last or p_last-p_first>366 then raise exception 'Invalid period range'; end if;
 perform pg_advisory_xact_lock_shared(hashtextextended('workforce-config:'||p_org::text,0));
 for m in select generate_series(date_trunc('month',p_first::timestamp),date_trunc('month',p_last::timestamp),interval '1 month') loop
  key:=hashtextextended('workforce-period:'||p_org::text||':'||m::date::text,0);
  if p_exclusive then perform pg_advisory_xact_lock(key); else perform pg_advisory_xact_lock_shared(key); end if;
 end loop;
end $$;
create function wf_private.guard_configuration() returns trigger language plpgsql security definer set search_path=''
as $$ begin
 perform pg_advisory_xact_lock(hashtextextended('workforce-config:'||wf_private.default_organization()::text,0));
 if tg_op='DELETE' then return old; end if; return new;
end $$;
create trigger workforce_policy_guard before insert or update or delete on public.attendance_policies for each row execute function wf_private.guard_configuration();
create trigger workforce_shift_guard before insert or update or delete on public.config_shifts for each row execute function wf_private.guard_configuration();
create trigger workforce_holiday_guard before insert or update or delete on public.holidays for each row execute function wf_private.guard_configuration();

create function wf_private.maintain(p_org uuid default null) returns jsonb language plpgsql security definer set search_path=''
as $function$
declare e public.employees%rowtype; pol public.attendance_policies%rowtype; s public.config_shifts%rowtype;
 sa public.shift_assignments%rowtype; t public.timesheets%rowtype; req public.attendance_requests%rowtype;
 today date:=(clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date; now_at timestamptz:=clock_timestamp();
 d date; start_at timestamptz; end_at timestamptz; deadline timestamptz; desired text; code text; paid integer; n integer:=0;
begin
 for e in select * from public.employees where status='Active' and role<>'Kiosk' and (p_org is null or organization_id=p_org) order by organization_id,employee_id loop
  select * into pol from public.attendance_policies where id=e.attendance_policy_id and active;
  if not found then continue; end if;
  perform wf_private.period_lock(e.organization_id,greatest(today-31,coalesce(e.employment_start_date,(e.created_at at time zone 'Asia/Ho_Chi_Minh')::date)),today);
  for d in select g::date from generate_series(greatest(today-31,coalesce(e.employment_start_date,(e.created_at at time zone 'Asia/Ho_Chi_Minh')::date)),today,interval '1 day') g loop
   if e.employment_end_date is not null and d>e.employment_end_date then continue; end if;
   if exists(select 1 from public.attendance_periods ap where ap.organization_id=e.organization_id and ap.status='CLOSED' and d between ap.period_start and ap.period_end) then continue; end if;
   select * into sa from public.shift_assignments where employee_id=e.employee_id and work_date=d and publication_status='PUBLISHED';
   if sa.id is null and not(extract(isodow from d)::smallint=any(pol.work_days)) then continue; end if;
   start_at:=(d+pol.expected_start) at time zone 'Asia/Ho_Chi_Minh';
   end_at:=(d+pol.expected_end+case when pol.expected_end<=pol.expected_start then interval '1 day' else interval '0 days' end) at time zone 'Asia/Ho_Chi_Minh';
   if sa.id is not null then
    select * into s from public.config_shifts where id=sa.shift_id;
    start_at:=(d+s.start_time) at time zone 'Asia/Ho_Chi_Minh';
    end_at:=(d+s.end_time+case when s.end_time<=s.start_time then interval '1 day' else interval '0 days' end) at time zone 'Asia/Ho_Chi_Minh';
   end if;
   deadline:=start_at+(pol.checkin_window_end-pol.expected_start);
   select * into t from public.timesheets where employee_id=e.employee_id and work_date=d for update;
   if t.actual_checkin is not null then
    if t.actual_checkout is null and now_at>coalesce(t.expected_end,end_at)+interval '15 minutes' and t.status in ('OPEN','COMPLETE') then
     update public.timesheets set status='EXCEPTION',exception_codes=array_append(array_remove(coalesce(exception_codes,'{}'),'MISSING_CHECKOUT'),'MISSING_CHECKOUT') where id=t.id;
     n:=n+1;
    end if;
    if t.actual_checkout is null and now_at>coalesce(t.expected_end,end_at) then
     perform wf_private.notify(e.employee_id,'checkout:'||d::text,'CHECKOUT_REMINDER','Ca làm đã kết thúc','Bạn còn ca chưa check-out.',jsonb_build_object('date',d));
    end if;
    continue;
   end if;
   if t.id is not null and t.status in ('LOCKED','PENDING_REVIEW') then continue; end if;
   desired:='EXCEPTION'; code:='MISSING_CHECKIN'; paid:=0;
   if exists(select 1 from public.holidays h where h.active and d between h.from_date and h.to_date) then desired:='APPROVED'; code:='HOLIDAY';
   else
    select * into req from public.attendance_requests r where r.employee_id=e.employee_id and r.status='APPROVED' and d between r.from_date and r.to_date
     and r.request_type in ('ANNUAL_LEAVE','SICK_LEAVE','UNPAID_LEAVE','BUSINESS_TRIP','REMOTE_WORK') order by created_at desc limit 1;
    if found then
     desired:='APPROVED'; code:='APPROVED_LEAVE';
     if req.request_type='ANNUAL_LEAVE' then paid:=greatest(0,(extract(epoch from(end_at-start_at))/60)::integer-pol.unpaid_break_minutes); end if;
    end if;
   end if;
   if desired='EXCEPTION' and not wf_private.is_due(d,deadline,now_at) then
    if d=today and now_at>=start_at-interval '15 minutes' then
     perform wf_private.notify(e.employee_id,'checkin:'||d::text,'CHECKIN_REMINDER','Sắp đến giờ làm việc','Kiểm tra lịch và chấm công khi đến nơi.',jsonb_build_object('date',d));
    end if;
    continue;
   end if;
   if t.id is not null and (t.source='ADJUSTED' or (t.status='APPROVED' and not(t.exception_codes&&array['HOLIDAY','APPROVED_LEAVE']))) then continue; end if;
   insert into public.timesheets(employee_id,work_date,policy_id,location_id,expected_start,expected_end,status,exception_codes,paid_leave_minutes)
   values(e.employee_id,d,pol.id,coalesce(sa.location_id,e.center_id),start_at,end_at,desired,array[code],paid)
   on conflict(employee_id,work_date) do update set status=excluded.status,exception_codes=excluded.exception_codes,paid_leave_minutes=excluded.paid_leave_minutes
   where timesheets.actual_checkin is null and timesheets.status not in ('LOCKED','PENDING_REVIEW') and timesheets.source<>'ADJUSTED'
     and (timesheets.status is distinct from excluded.status or timesheets.exception_codes is distinct from excluded.exception_codes or timesheets.paid_leave_minutes<>excluded.paid_leave_minutes);
   if found then n:=n+1; end if;
  end loop;
 end loop;
 -- Escalation never approves a request automatically and never assigns it to its author.
 for req in select r.* from public.attendance_requests r where r.status='PENDING' and r.due_at<now_at and r.escalated_at is null
  and (p_org is null or r.organization_id=p_org) order by r.id for update loop
  if req.fallback_to is not null and req.fallback_to<>req.employee_id and exists(select 1 from public.employees x where x.employee_id=req.fallback_to and x.status='Active' and x.organization_id=req.organization_id) then
   update public.attendance_requests set assigned_to=fallback_to,escalated_at=now_at where id=req.id;
   perform wf_private.notify(req.fallback_to,'overdue:'||req.id::text,'REQUEST_OVERDUE','Yêu cầu đã quá hạn xử lý','Bạn được chỉ định xử lý thay.',jsonb_build_object('request_id',req.id));
  else
   perform wf_private.notify(req.assigned_to,'overdue:'||req.id::text,'REQUEST_OVERDUE','Yêu cầu đang quá hạn','Vui lòng xử lý yêu cầu trong hàng chờ.',jsonb_build_object('request_id',req.id));
  end if;
 end loop;
 return jsonb_build_object('ok',true,'changed',n,'run_at',now_at);
end $function$;

create function wf_private.fingerprint(p_first date,p_last date) returns text language plpgsql stable security definer set search_path=''
as $$ declare a public.employees%rowtype; sheets text; requests text; config text; begin
 a:=wf_private.actor();
 select coalesce(string_agg(id::text||':'||revision::text,',' order by id),'') into sheets from public.timesheets where organization_id=a.organization_id and work_date between p_first and p_last;
 select coalesce(string_agg(id::text||':'||revision::text,',' order by id),'') into requests from public.attendance_requests where organization_id=a.organization_id and daterange(from_date,to_date,'[]')&&daterange(p_first,p_last,'[]');
 select coalesce(jsonb_agg(to_jsonb(p) order by id)::text,'') into config from public.attendance_policies p where organization_id=a.organization_id;
 return encode(extensions.digest(sheets||'|'||requests||'|'||config,'sha256'),'hex');
end $$;

create function wf_private.payroll_checklist(p_first date,p_last date) returns jsonb language plpgsql stable security definer set search_path=''
as $function$
declare a public.employees%rowtype; today date:=(clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date;
 rows_count integer; unresolved integer; pending integer; missing_policy integer; missing_days integer; unassigned integer;
 hash text; exported uuid; period public.attendance_periods%rowtype; items jsonb; ready boolean;
begin
 a:=wf_private.require_capability('attendance.export');
 if not wf_private.capable('team.read_all') then raise exception 'Đối soát kỳ công toàn tổ chức cần quyền phù hợp.' using errcode='42501'; end if;
 if p_first is null or p_last is null or p_first<>date_trunc('month',p_first)::date or p_last<>(date_trunc('month',p_first)+interval '1 month-1 day')::date then raise exception 'Chọn đúng một tháng dương lịch.'; end if;
 select * into period from public.attendance_periods where organization_id=a.organization_id and period_start=p_first and period_end=p_last;
 select count(*),count(*) filter(where status in ('SCHEDULED','OPEN','EXCEPTION','PENDING_REVIEW','REJECTED')) into rows_count,unresolved
 from public.timesheets where organization_id=a.organization_id and work_date between p_first and least(p_last,today) and status<>'CANCELLED';
 select count(*),count(*) filter(where assigned_to is null) into pending,unassigned from public.attendance_requests
 where organization_id=a.organization_id and status='PENDING' and daterange(from_date,to_date,'[]')&&daterange(p_first,p_last,'[]');
 select count(*) into missing_policy from public.employees e where e.organization_id=a.organization_id and e.status='Active' and e.role<>'Kiosk'
 and not exists(select 1 from public.attendance_policies p where p.id=e.attendance_policy_id and p.active);
 select count(*) into missing_days from public.employees e join public.attendance_policies p on p.id=e.attendance_policy_id
 cross join lateral generate_series(greatest(p_first,coalesce(e.employment_start_date,(e.created_at at time zone 'Asia/Ho_Chi_Minh')::date)),least(p_last,today),interval '1 day') g
 where e.organization_id=a.organization_id and e.status='Active' and e.role<>'Kiosk'
 and (extract(isodow from g)::smallint=any(p.work_days) or exists(select 1 from public.shift_assignments sa where sa.employee_id=e.employee_id and sa.work_date=g::date and sa.publication_status='PUBLISHED'))
 and not exists(select 1 from public.timesheets t where t.employee_id=e.employee_id and t.work_date=g::date and t.status<>'CANCELLED');
 hash:=wf_private.fingerprint(p_first,p_last);
 select id into exported from public.workforce_payroll_exports where organization_id=a.organization_id and period_start=p_first and period_end=p_last and invalidated_at is null and fingerprint=hash order by created_at desc limit 1;
 items:=jsonb_build_array(
  jsonb_build_object('key','ended','label','Kỳ công đã kết thúc','pass',p_last<today,'count',case when p_last<today then 0 else 1 end),
  jsonb_build_object('key','data','label','Có dữ liệu để đối soát','pass',rows_count>0,'count',rows_count),
  jsonb_build_object('key','exceptions','label','Không còn ngày công chưa xử lý','pass',unresolved=0,'count',unresolved),
  jsonb_build_object('key','requests','label','Không còn yêu cầu chờ duyệt','pass',pending=0,'count',pending),
  jsonb_build_object('key','policy','label','Nhân viên có chính sách công','pass',missing_policy=0,'count',missing_policy),
  jsonb_build_object('key','missing','label','Không thiếu ngày công dự kiến','pass',missing_days=0,'count',missing_days),
  jsonb_build_object('key','export','label','Đã xuất bản đối soát khớp dữ liệu hiện tại','pass',exported is not null or period.status='CLOSED','count',case when exported is null and coalesce(period.status,'')<>'CLOSED' then 1 else 0 end));
 ready:=p_last<today and rows_count>0 and unresolved=0 and pending=0 and missing_policy=0 and missing_days=0 and exported is not null and coalesce(period.status,'')<>'CLOSED';
 return jsonb_build_object('items',items,'ready',ready,'closed',coalesce(period.status='CLOSED',false),'fingerprint',hash,'export_id',exported,'unassigned_requests',unassigned);
end $function$;

create function wf_private.payroll_command(p_action text,p jsonb) returns jsonb language plpgsql security definer set search_path=''
as $function$
declare a public.employees%rowtype; first_day date:=(p->>'from')::date; last_day date:=(p->>'to')::date;
 checklist jsonb; rows jsonb; hash text; export_id uuid; why text:=trim(coalesce(p->>'note','')); n integer;
begin
 a:=wf_private.require_capability(case when p_action='payroll.close' then 'attendance.lock_period' when p_action='payroll.reopen' then 'attendance.reopen_period' else 'attendance.export' end);
 if not wf_private.capable('team.read_all') then raise exception 'Cần phạm vi toàn tổ chức.' using errcode='42501'; end if;
 perform wf_private.period_lock(a.organization_id,first_day,last_day,true);
 checklist:=wf_private.payroll_checklist(first_day,last_day);
 if p_action='payroll.export' then
  select coalesce(jsonb_agg(to_jsonb(x) order by x.employee_id),'[]') into rows from (
   select e.employee_id,e.name,e.center_id,
    sum(t.work_minutes) filter(where t.status in ('COMPLETE','AUTO_APPROVED','APPROVED','LOCKED')) as accepted_work_minutes,
    sum(t.paid_leave_minutes) as approved_annual_leave_minutes,
    sum(t.late_minutes) as late_minutes,sum(t.early_minutes) as early_minutes,
    count(*) filter(where t.status in ('SCHEDULED','OPEN','EXCEPTION','PENDING_REVIEW','REJECTED')) as unresolved_days,
    count(*) as recorded_days
   from public.timesheets t join public.employees e using(employee_id)
   where t.organization_id=a.organization_id and t.work_date between first_day and last_day and t.status<>'CANCELLED'
   group by e.employee_id,e.name,e.center_id
  ) x;
  hash:=wf_private.fingerprint(first_day,last_day);
  insert into public.workforce_payroll_exports(organization_id,period_start,period_end,created_by,fingerprint,payload)
  values(a.organization_id,first_day,last_day,a.employee_id,hash,rows) returning id into export_id;
  perform wf_private.audit('PAYROLL_EXPORT_CREATED','payroll_export',export_id::text,'Xuất dữ liệu đối soát, không phải bảng lương',jsonb_build_object('from',first_day,'to',last_day,'fingerprint',hash));
  return jsonb_build_object('ok',true,'export_id',export_id,'fingerprint',hash,'rows',rows,'draft',not coalesce((checklist->>'closed')::boolean,false));
 elsif p_action='payroll.close' then
  if not coalesce((checklist->>'ready')::boolean,false) then raise exception 'Chưa đủ điều kiện đóng kỳ. Xử lý checklist và xuất lại bản đối soát.'; end if;
  if length(why)<5 then raise exception 'Ghi chú đóng kỳ cần ít nhất 5 ký tự.'; end if;
  update public.timesheets set status_before_lock=status,status='LOCKED',locked_at=clock_timestamp(),locked_by=a.employee_id
   where organization_id=a.organization_id and work_date between first_day and last_day and status<>'CANCELLED';
  get diagnostics n=row_count;
  insert into public.attendance_periods(period_start,period_end,status,closed_by,closed_at,note,organization_id)
  values(first_day,last_day,'CLOSED',a.employee_id,clock_timestamp(),why,a.organization_id)
  on conflict(period_start,period_end) do update set status='CLOSED',closed_by=excluded.closed_by,closed_at=excluded.closed_at,note=excluded.note,updated_at=clock_timestamp();
  perform wf_private.audit('PAYROLL_PERIOD_CLOSED','attendance_period',first_day::text,why,jsonb_build_object('count',n,'export_id',checklist->>'export_id','fingerprint',checklist->>'fingerprint'));
  return jsonb_build_object('ok',true,'count',n);
 elsif p_action='payroll.reopen' then
  if length(why)<10 then raise exception 'Mở lại kỳ phải có lý do ít nhất 10 ký tự.'; end if;
  if not exists(select 1 from public.attendance_periods where organization_id=a.organization_id and period_start=first_day and period_end=last_day and status='CLOSED') then raise exception 'Kỳ công chưa đóng.'; end if;
  -- Existing locked-timesheet guards may require a dedicated maintenance override.
  -- Do not bypass them: reopen is kept pending until the active guard is verified in staging.
  raise exception 'Mở lại kỳ cần quy trình HR có đối soát; chưa bật thao tác này trong bản phát hành.';
 end if;
 raise exception 'Unknown payroll action';
end $function$;
revoke all on all functions in schema wf_private from public,anon,authenticated;

-- ============================================================================
-- database/releases/04_workforce_api.sql  (git blob 170f3e1f3b08261de109e4eba0bda058a71f0ca8)
-- ============================================================================
-- Bounded server-side queries. Browser filters are presentation, never authorization.
create function wf_private.query(p_resource text,p jsonb default '{}') returns jsonb language plpgsql stable security definer set search_path=''
as $function$
declare a public.employees%rowtype; result jsonb; rows jsonb; total bigint; caps jsonb;
 page_no integer:=greatest(1,coalesce((p->>'page')::integer,1)); page_size integer:=least(100,greatest(1,coalesce((p->>'size')::integer,25)));
 skip integer; first_day date:=coalesce((p->>'from')::date,date_trunc('month',clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date);
 last_day date:=coalesce((p->>'to')::date,(date_trunc('month',clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')+interval '1 month-1 day')::date);
 today date:=(clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date;
 team boolean:=coalesce(p->>'scope','me')='team'; needle text:='%'||left(coalesce(p->>'search',''),100)||'%';
 state text:=coalesce(p->>'status','all'); t public.timesheets%rowtype; pol public.attendance_policies%rowtype;
 sa public.shift_assignments%rowtype; shift public.config_shifts%rowtype; planned jsonb; receipt jsonb;
begin
 a:=wf_private.actor(); skip:=(page_no-1)*page_size;
 if first_day>last_day or last_day-first_day>366 then raise exception 'Khoảng ngày tối đa 366 ngày.'; end if;
 if team and not wf_private.capable('team.read') then raise exception 'Không có quyền xem nhóm.' using errcode='42501'; end if;
 if p_resource='bootstrap' then
  select coalesce(jsonb_agg(capability order by capability),'[]') into caps from (select distinct capability from public.workforce_role_capabilities union select capability from public.workforce_employee_capabilities) x where wf_private.capable(capability);
  select * into t from public.timesheets where employee_id=a.employee_id and ((actual_checkin is not null and actual_checkout is null and status not in ('LOCKED','CANCELLED')) or work_date=today)
   order by (actual_checkin is not null and actual_checkout is null) desc,work_date desc limit 1;
  select * into pol from public.attendance_policies where id=a.attendance_policy_id and active;
  select * into sa from public.shift_assignments where employee_id=a.employee_id and work_date=today and publication_status='PUBLISHED';
  if sa.id is not null then select * into shift from public.config_shifts where id=sa.shift_id; end if;
  planned:=jsonb_build_object('work_date',today,'shift_name',coalesce(shift.name,pol.name),'location_id',coalesce(sa.location_id,a.center_id),
    'expected_start',(today+coalesce(shift.start_time,pol.expected_start)) at time zone 'Asia/Ho_Chi_Minh',
    'expected_end',(today+coalesce(shift.end_time,pol.expected_end)+case when coalesce(shift.end_time,pol.expected_end)<=coalesce(shift.start_time,pol.expected_start) then interval '1 day' else interval '0 day' end) at time zone 'Asia/Ho_Chi_Minh',
    'scheduled',sa.id is not null or extract(isodow from today)::smallint=any(pol.work_days));
  select payload->'receipt' into receipt from public.workforce_receipts where employee_id=a.employee_id order by created_at desc limit 1;
  select jsonb_build_object('work_minutes',coalesce(sum(work_minutes) filter(where status in ('COMPLETE','AUTO_APPROVED','APPROVED','LOCKED')),0),
    'exceptions',count(*) filter(where status in ('EXCEPTION','PENDING_REVIEW','REJECTED')),'days',count(*) filter(where actual_checkin is not null),
    'remaining_leave',coalesce(a.annual_leave_balance,0)) into result
   from public.timesheets where employee_id=a.employee_id and work_date between first_day and today and status not in ('SCHEDULED','CANCELLED');
  return jsonb_build_object('version',3,'server_time',clock_timestamp(),'profile',to_jsonb(a),'capabilities',caps,
    'today',case when t.id is null then null else to_jsonb(t) end,'planned',planned,'latest_receipt',receipt,'summary',result,
    'unread', (select count(*) from public.workforce_notifications where employee_id=a.employee_id and read_at is null),
    'policy',case when pol.id is null then null else to_jsonb(pol) end);
 elsif p_resource='history' then
  select count(*) into total from public.timesheets t join public.employees e using(employee_id)
  where t.organization_id=a.organization_id and t.employee_id in(select wf_private.scope_ids()) and (team or t.employee_id=a.employee_id)
    and t.work_date between first_day and last_day and t.status<>'CANCELLED' and (state='all' or t.status=state) and (e.name ilike needle or e.employee_id ilike needle);
  select coalesce(jsonb_agg(to_jsonb(x)),'[]') into rows from (
   select t.*,e.name as employee_name,l.center_name as location_name from public.timesheets t join public.employees e using(employee_id) left join public.locations l on l.center_id=t.location_id
   where t.organization_id=a.organization_id and t.employee_id in(select wf_private.scope_ids()) and (team or t.employee_id=a.employee_id)
    and t.work_date between first_day and last_day and t.status<>'CANCELLED' and (state='all' or t.status=state) and (e.name ilike needle or e.employee_id ilike needle)
   order by t.work_date desc,t.id limit page_size offset skip
  ) x;
 elsif p_resource='requests' then
  select count(*) into total from public.attendance_requests r join public.employees e using(employee_id)
   where r.organization_id=a.organization_id and ((team and r.employee_id in(select wf_private.scope_ids())) or r.employee_id=a.employee_id or r.workflow_data->>'peer_employee_id'=a.employee_id)
    and (state='all' or r.status=state) and daterange(r.from_date,r.to_date,'[]')&&daterange(first_day,last_day,'[]') and (e.name ilike needle or r.reason ilike needle);
  select coalesce(jsonb_agg(to_jsonb(x)),'[]') into rows from (
   select r.*,e.name as employee_name,o.name as owner_name,b.name as backup_name from public.attendance_requests r join public.employees e using(employee_id)
   left join public.employees o on o.employee_id=r.assigned_to left join public.employees b on b.employee_id=r.fallback_to
   where r.organization_id=a.organization_id and ((team and r.employee_id in(select wf_private.scope_ids())) or r.employee_id=a.employee_id or r.workflow_data->>'peer_employee_id'=a.employee_id)
    and (state='all' or r.status=state) and daterange(r.from_date,r.to_date,'[]')&&daterange(first_day,last_day,'[]') and (e.name ilike needle or r.reason ilike needle)
   order by (r.status='PENDING') desc,r.due_at,r.id limit page_size offset skip
  ) x;
 elsif p_resource='directory' then
  perform wf_private.require_capability('directory.read');
  select count(*) into total from public.employees e where e.organization_id=a.organization_id and e.role<>'Kiosk' and (state='all' or e.status=state) and (e.name ilike needle or e.employee_id ilike needle);
  select coalesce(jsonb_agg(to_jsonb(x)),'[]') into rows from (
   select employee_id,name,email,phone,position,department,center_id,avatar_url,status from public.employees e
   where e.organization_id=a.organization_id and e.role<>'Kiosk' and (state='all' or e.status=state) and (e.name ilike needle or e.employee_id ilike needle)
   order by name,employee_id limit page_size offset skip
  ) x;
 elsif p_resource='schedule' then
  if last_day-first_day>62 then raise exception 'Chỉ tải tối đa 63 ngày lịch mỗi lần.'; end if;
  select count(*) into total from public.shift_assignments x join public.employees e using(employee_id)
   where x.organization_id=a.organization_id and x.employee_id in(select wf_private.scope_ids()) and (team or x.employee_id=a.employee_id)
    and x.work_date between first_day and last_day and (x.publication_status='PUBLISHED' or wf_private.capable('schedule.manage')) and (e.name ilike needle or e.employee_id ilike needle);
  select coalesce(jsonb_agg(to_jsonb(x)),'[]') into rows from (
   select sa.*,e.name as employee_name,s.name as shift_name,s.start_time,s.end_time,l.center_name as location_name
   from public.shift_assignments sa join public.employees e using(employee_id) join public.config_shifts s on s.id=sa.shift_id left join public.locations l on l.center_id=sa.location_id
   where sa.organization_id=a.organization_id and sa.employee_id in(select wf_private.scope_ids()) and (team or sa.employee_id=a.employee_id)
    and sa.work_date between first_day and last_day and (sa.publication_status='PUBLISHED' or wf_private.capable('schedule.manage')) and (e.name ilike needle or e.employee_id ilike needle)
   order by sa.work_date,e.name,sa.id limit page_size offset skip
  ) x;
 elsif p_resource='inbox' then
  select count(*) into total from public.workforce_notifications where employee_id=a.employee_id;
  select coalesce(jsonb_agg(to_jsonb(x)),'[]') into rows from (select * from public.workforce_notifications where employee_id=a.employee_id order by created_at desc,id limit page_size offset skip) x;
 elsif p_resource='receipts' then
  select count(*) into total from public.workforce_receipts r where r.organization_id=a.organization_id and r.employee_id in(select wf_private.scope_ids()) and (team or r.employee_id=a.employee_id)
   and (p->>'timesheet_id' is null or r.payload->'receipt'->>'timesheet_id'=p->>'timesheet_id');
  select coalesce(jsonb_agg(x.payload->'receipt'),'[]') into rows from (
   select r.* from public.workforce_receipts r where r.organization_id=a.organization_id and r.employee_id in(select wf_private.scope_ids()) and (team or r.employee_id=a.employee_id)
    and (p->>'timesheet_id' is null or r.payload->'receipt'->>'timesheet_id'=p->>'timesheet_id') order by r.created_at desc limit page_size offset skip
  ) x;
 elsif p_resource='metadata' then
  return jsonb_build_object(
   'shifts',(select coalesce(jsonb_agg(to_jsonb(s) order by sort_order),'[]') from public.config_shifts s where s.active),
   'locations',(select coalesce(jsonb_agg(to_jsonb(l) order by center_name),'[]') from public.locations l where l.organization_id=a.organization_id and l.active and
    (wf_private.capable('team.read_all') or l.center_id=a.center_id or l.center_id=any(a.allowed_locations) or l.center_id=any(a.managed_locations))),
   'holidays',(select coalesce(jsonb_agg(to_jsonb(h) order by from_date),'[]') from public.holidays h where active and to_date>=today-366 and from_date<=today+366),
   'templates',(select coalesce(jsonb_agg(to_jsonb(s) order by name),'[]') from public.workforce_schedule_templates s where s.organization_id=a.organization_id and wf_private.capable('schedule.manage')));
 elsif p_resource='overview' then
  perform wf_private.require_capability('team.read');
  return jsonb_build_object(
   'server_time',clock_timestamp(),
   'active_employees',(select count(*) from public.employees e where e.employee_id in(select wf_private.scope_ids()) and e.status='Active' and e.role<>'Kiosk'),
   'checked_in',(select count(distinct employee_id) from public.timesheets where employee_id in(select wf_private.scope_ids()) and work_date=today and actual_checkin is not null),
   'working',(select count(distinct employee_id) from public.timesheets where employee_id in(select wf_private.scope_ids()) and actual_checkin is not null and actual_checkout is null and status not in ('LOCKED','CANCELLED')),
   'exceptions',(select count(*) from public.timesheets where employee_id in(select wf_private.scope_ids()) and work_date between first_day and least(last_day,today) and status in ('EXCEPTION','REJECTED')),
   'pending',(select count(*) from public.attendance_requests where employee_id in(select wf_private.scope_ids()) and status='PENDING'),
   'overdue',(select count(*) from public.attendance_requests where employee_id in(select wf_private.scope_ids()) and status='PENDING' and due_at<clock_timestamp()),
   'unassigned',(select count(*) from public.attendance_requests where employee_id in(select wf_private.scope_ids()) and status='PENDING' and assigned_to is null),
   'future_exceptions',(select count(*) from public.timesheets where employee_id in(select wf_private.scope_ids()) and work_date>today and status='EXCEPTION'),
   'unresolved',(select count(*) from public.timesheets where employee_id in(select wf_private.scope_ids()) and work_date between first_day and least(last_day,today) and status in ('OPEN','EXCEPTION','REJECTED','PENDING_REVIEW')),
   'closed_days',(select count(*) from public.timesheets where employee_id in(select wf_private.scope_ids()) and work_date between first_day and least(last_day,today) and status in ('APPROVED','AUTO_APPROVED','COMPLETE','LOCKED')),
   'offline_kiosks',(select count(*) from public.qr_stations where organization_id=a.organization_id and active and updated_at<clock_timestamp()-interval '90 seconds'));
 elsif p_resource='coverage' then
  perform wf_private.require_capability('schedule.manage');
  if last_day-first_day>62 then raise exception 'Khoảng kiểm tra nhân sự quá dài.'; end if;
  select coalesce(jsonb_agg(to_jsonb(x)),'[]') into rows from (
   select g::date as work_date,l.center_name,s.name as shift_name,r.minimum_people,count(sa.id)::integer as assigned,
    greatest(0,r.minimum_people-count(sa.id)::integer) as missing
   from public.workforce_staffing_rules r join public.locations l on l.center_id=r.location_id join public.config_shifts s on s.id=r.shift_id
   cross join generate_series(first_day,last_day,interval '1 day') g
   left join public.shift_assignments sa on sa.location_id=r.location_id and sa.shift_id=r.shift_id and sa.work_date=g::date and sa.publication_status='PUBLISHED'
    and sa.employee_id in(select e.employee_id from public.employees e where e.status='Active')
   where r.organization_id=a.organization_id and extract(isodow from g)::integer=r.weekday
    and (wf_private.capable('team.read_all') or r.location_id=any(a.managed_locations))
   group by g,l.center_name,s.name,r.minimum_people order by g,l.center_name limit 500
  ) x; return jsonb_build_object('rows',rows,'total',jsonb_array_length(rows),'configured',(select count(*) from public.workforce_staffing_rules where organization_id=a.organization_id));
 elsif p_resource='checklist' then return wf_private.payroll_checklist(first_day,last_day);
 elsif p_resource='audit' then
  perform wf_private.require_capability('audit.view');
  select count(*) into total from public.audit_logs x where x.metadata->>'organization_id'=a.organization_id::text;
  select coalesce(jsonb_agg(to_jsonb(x)),'[]') into rows from (select * from public.audit_logs where metadata->>'organization_id'=a.organization_id::text order by created_at desc,id limit page_size offset skip) x;
 elsif p_resource='metrics' then
  perform wf_private.require_capability('audit.view');
  return jsonb_build_object('sample_count',(select count(*) from public.workforce_metrics where organization_id=a.organization_id and created_at>=clock_timestamp()-interval '7 days' and kind='CLIENT_ATTENDANCE'),
   'p95_ms',(select percentile_disc(0.95) within group(order by duration_ms) from public.workforce_metrics where organization_id=a.organization_id and kind='CLIENT_ATTENDANCE' and duration_ms is not null and created_at>=clock_timestamp()-interval '7 days'),
   'failures',(select coalesce(jsonb_agg(to_jsonb(x)),'[]') from (select code,count(*) as count from public.workforce_metrics where organization_id=a.organization_id and kind='CLIENT_ATTENDANCE' and code<>'SUCCESS' and created_at>=clock_timestamp()-interval '7 days' group by code order by count(*) desc) x));
 elsif p_resource='admin_config' then
  if not(wf_private.capable('settings.manage') or wf_private.capable('employee.manage') or wf_private.capable('kiosk.manage')) then raise exception 'Không có quyền cấu hình.' using errcode='42501'; end if;
  -- Reference data is bounded; employee management has a separate server-side page.
  return jsonb_build_object('employees','[]'::jsonb,'locations',(select coalesce(jsonb_agg(to_jsonb(l)),'[]') from public.locations l where organization_id=a.organization_id),
   'policies',(select coalesce(jsonb_agg(to_jsonb(x)),'[]') from public.attendance_policies x where organization_id=a.organization_id),
   'stations',(select coalesce(jsonb_agg(to_jsonb(x)),'[]') from public.qr_stations x where organization_id=a.organization_id),
   'devices','[]'::jsonb,'shifts',(select coalesce(jsonb_agg(to_jsonb(x)),'[]') from public.config_shifts x),
   'systemSettings',(select coalesce(jsonb_agg(to_jsonb(x)),'[]') from public.config_system x),
   'holidays',(select coalesce(jsonb_agg(to_jsonb(x)),'[]') from public.holidays x),
   'timesheets','[]'::jsonb,'requests','[]'::jsonb,'shiftAssignments','[]'::jsonb,'attendancePeriods','[]'::jsonb,'auditLogs','[]'::jsonb,
   'features',jsonb_build_object('workforceOperations',true));
 elsif p_resource='people_admin' then
  perform wf_private.require_capability('employee.manage');
  select count(*) into total from public.employees e where organization_id=a.organization_id and (e.name ilike needle or e.employee_id ilike needle) and (state='all' or e.status=state);
  select coalesce(jsonb_agg(to_jsonb(x)),'[]') into rows from (select e.*,e.employee_id as id from public.employees e where organization_id=a.organization_id and (e.name ilike needle or e.employee_id ilike needle) and (state='all' or e.status=state) order by name,employee_id limit page_size offset skip) x;
 else raise exception 'Unknown query resource'; end if;
 return jsonb_build_object('rows',coalesce(rows,'[]'),'total',coalesce(total,0),'page',page_no,'size',page_size);
end $function$;

create function wf_private.command(p_action text,p jsonb) returns jsonb language plpgsql security definer set search_path=''
as $$ declare a public.employees%rowtype; n integer; entry jsonb; cap text; target text; begin
 a:=wf_private.actor();
 if p_action='attendance' then return wf_private.attendance(p);
 elsif p_action like 'request.%' then return wf_private.request_command(p_action,p);
 elsif p_action like 'schedule.%' then return wf_private.schedule_command(p_action,p);
 elsif p_action in ('payroll.export','payroll.close') then return wf_private.payroll_command(p_action,p);
 elsif p_action='maintenance.run' then
  perform wf_private.require_capability('team.read_all'); return wf_private.maintain(a.organization_id);
 elsif p_action='notification.read' then
  update public.workforce_notifications set read_at=coalesce(read_at,clock_timestamp()) where employee_id=a.employee_id and (coalesce((p->>'all')::boolean,false) or id=(p->>'id')::uuid);
  get diagnostics n=row_count; return jsonb_build_object('ok',true,'count',n);
 elsif p_action='telemetry.track' then
  if p->>'kind' not in ('CLIENT_ATTENDANCE','FRONTEND','LOAD') or coalesce(p->>'code','') !~ '^[A-Z0-9_]{2,48}$' then raise exception 'Invalid telemetry'; end if;
  if (select count(*) from public.workforce_metrics where employee_id=a.employee_id and created_at>clock_timestamp()-interval '1 minute')<60 then
   insert into public.workforce_metrics(organization_id,employee_id,kind,code,duration_ms) values(a.organization_id,a.employee_id,p->>'kind',p->>'code',least(120000,greatest(0,(p->>'duration_ms')::integer)));
  end if; return jsonb_build_object('ok',true);
 elsif p_action='capability.grant' then
  perform wf_private.require_capability('capability.manage'); cap:=p->>'capability'; target:=p->>'employee_id';
  if cap not in ('team.read','attendance.review','schedule.manage','schedule.override','audit.view','attendance.export','attendance.lock_period') then raise exception 'Chỉ phân quyền nghiệp vụ trong danh sách cho phép.'; end if;
  if not exists(select 1 from public.employees where employee_id=target and organization_id=a.organization_id and status='Active') then raise exception 'Nhân viên không hợp lệ.'; end if;
  insert into public.workforce_employee_capabilities(organization_id,employee_id,capability,enabled) values(a.organization_id,target,cap,(p->>'enabled')::boolean)
   on conflict(employee_id,capability) do update set enabled=excluded.enabled;
  perform wf_private.audit('CAPABILITY_CHANGED','employee',target,'Phân quyền nghiệp vụ',jsonb_build_object('capability',cap,'enabled',p->'enabled'));
  return jsonb_build_object('ok',true);
 end if;
 raise exception 'Unknown command action';
end $$;

create function public.workforce_query(p_resource text,p_args jsonb default '{}') returns jsonb language sql security invoker set search_path=''
as $$ select wf_private.query(p_resource,p_args) $$;
create function public.workforce_command(p_action text,p_args jsonb default '{}') returns jsonb language sql security invoker set search_path=''
as $$ select wf_private.command(p_action,p_args) $$;
revoke all on function public.workforce_query(text,jsonb),public.workforce_command(text,jsonb) from public,anon;
revoke all on all functions in schema wf_private from public,anon,authenticated;
grant usage on schema wf_private to authenticated,service_role;
grant execute on function wf_private.query(text,jsonb),wf_private.command(text,jsonb) to authenticated;
grant execute on function wf_private.default_organization() to authenticated,service_role;
grant execute on function public.workforce_query(text,jsonb),public.workforce_command(text,jsonb) to authenticated;

do $verify$
begin
  if to_regprocedure('public.workforce_query(text,jsonb)') is null or to_regprocedure('public.workforce_command(text,jsonb)') is null then raise exception 'Required Workforce API was not installed'; end if;
  if has_function_privilege('anon','public.workforce_query(text,jsonb)','execute') or has_function_privilege('anon','public.workforce_command(text,jsonb)','execute') then raise exception 'Anonymous access must remain denied'; end if;
  if not has_function_privilege('authenticated','public.workforce_query(text,jsonb)','execute') or not has_function_privilege('authenticated','public.workforce_command(text,jsonb)','execute') then raise exception 'Authenticated API grants missing'; end if;
  if exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and (c.relname='organizations' or c.relname like 'workforce_%') and c.relkind='r' and not c.relrowsecurity) then raise exception 'RLS is missing on a new table'; end if;
end $verify$;

create table if not exists wf_private.release_sources (
  release text not null,
  ordinal integer not null,
  source_commit text not null,
  source_path text not null,
  git_blob_sha text not null,
  sql_body text not null,
  applied_at timestamptz not null default clock_timestamp(),
  primary key (release, ordinal)
);
revoke all on wf_private.release_sources from public, anon, authenticated;

insert into wf_private.release_sources (release, ordinal, source_commit, source_path, git_blob_sha, sql_body) values
  ('workforce-v3', 1, 'f92cc58d9b54e3e50d382c42b25479212ac9b183', 'database/releases/00_stability.sql', '70b1cade198ec8a89ec3bc21b0b8ac45a85f474e', 'Vendored inline in supabase/migrations/20260905032637_deploy_workforce_v3_verified_release.sql on 2026-09-11; see git history for exact content.'),
  ('workforce-v3', 2, 'f92cc58d9b54e3e50d382c42b25479212ac9b183', 'database/releases/00a_event_metadata.sql', 'ff10bcbb313524ab36d6be0ee0bebca5a29f9d17', 'Vendored inline in supabase/migrations/20260905032637_deploy_workforce_v3_verified_release.sql on 2026-09-11; see git history for exact content.'),
  ('workforce-v3', 3, 'f92cc58d9b54e3e50d382c42b25479212ac9b183', 'database/releases/01_workforce_core.sql', 'c9fa0c5a43024e26a844ba77b643cd9c5bd84f22', 'Vendored inline in supabase/migrations/20260905032637_deploy_workforce_v3_verified_release.sql on 2026-09-11; see git history for exact content.'),
  ('workforce-v3', 4, 'f92cc58d9b54e3e50d382c42b25479212ac9b183', 'database/releases/01a_event_metadata_verified.sql', '1225b4605a0529b90b1ab0b898c479c0c0721f0d', 'Vendored inline in supabase/migrations/20260905032637_deploy_workforce_v3_verified_release.sql on 2026-09-11; see git history for exact content.'),
  ('workforce-v3', 5, 'f92cc58d9b54e3e50d382c42b25479212ac9b183', 'database/releases/02_workforce_operations.sql', '8112daf19b5135791ed16433da53e3628fd008c4', 'Vendored inline in supabase/migrations/20260905032637_deploy_workforce_v3_verified_release.sql on 2026-09-11; see git history for exact content.'),
  ('workforce-v3', 6, 'f92cc58d9b54e3e50d382c42b25479212ac9b183', 'database/releases/03_maintenance_payroll.sql', '2d0c58432ba972c20f3e665f0c2afb6f248e7f79', 'Vendored inline in supabase/migrations/20260905032637_deploy_workforce_v3_verified_release.sql on 2026-09-11; see git history for exact content.'),
  ('workforce-v3', 7, 'f92cc58d9b54e3e50d382c42b25479212ac9b183', 'database/releases/04_workforce_api.sql', '170f3e1f3b08261de109e4eba0bda058a71f0ca8', 'Vendored inline in supabase/migrations/20260905032637_deploy_workforce_v3_verified_release.sql on 2026-09-11; see git history for exact content.')
on conflict (release, ordinal) do nothing;

insert into wf_private.upgrade_snapshots(release, source_table, source_id, reason, row_data)
values (
  'workforce-v3-deploy',
  'deployment',
  'f92cc58d9b54e3e50d382c42b25479212ac9b183',
  'Vendored source (2026-09-11): removed the runtime HTTP fetch to a since-deleted GitHub repo (laomatday/genai-erp, confirmed 404); SQL is now inlined and version-controlled. No schema/logic change versus the original 2026-09-05 apply.',
  jsonb_build_object('files', '[{"path":"00_stability.sql","sha":"70b1cade198ec8a89ec3bc21b0b8ac45a85f474e"},{"path":"00a_event_metadata.sql","sha":"ff10bcbb313524ab36d6be0ee0bebca5a29f9d17"},{"path":"01_workforce_core.sql","sha":"c9fa0c5a43024e26a844ba77b643cd9c5bd84f22"},{"path":"01a_event_metadata_verified.sql","sha":"1225b4605a0529b90b1ab0b898c479c0c0721f0d"},{"path":"02_workforce_operations.sql","sha":"8112daf19b5135791ed16433da53e3628fd008c4"},{"path":"03_maintenance_payroll.sql","sha":"2d0c58432ba972c20f3e665f0c2afb6f248e7f79"},{"path":"04_workforce_api.sql","sha":"170f3e1f3b08261de109e4eba0bda058a71f0ca8"}]'::jsonb)
)
on conflict (release, source_table, source_id) do nothing;

notify pgrst, 'reload schema';
