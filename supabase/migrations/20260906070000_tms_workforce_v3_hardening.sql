-- genAi TMS hardening on top of the deployed Workforce V3 release.
-- P0: tenant-safe management scope and remove legacy attendance write surfaces.
-- P2: add a one-roundtrip employee dashboard bundle and covering indexes.
-- Existing Workforce V3 remains the single source of truth.

begin;

-- Tenant-safe management helper. employee_id is globally unique today, but the
-- organization predicate is required defense-in-depth for a multi-tenant future.
create or replace function tms_private.can_manage_employee(p_employee_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  with actor as (
    select employee_id, role, managed_locations, organization_id
    from public.employees
    where auth_user_id = (select auth.uid()) and status = 'Active'
    limit 1
  ), target as (
    select employee_id, center_id, direct_manager_id, organization_id
    from public.employees
    where employee_id = p_employee_id
  )
  select exists (
    select 1
    from actor a
    cross join target t
    where t.organization_id = a.organization_id
      and (
        a.role in ('Admin','HR','Director')
        or (
          a.role in ('Manager','Leader')
          and (
            t.direct_manager_id = a.employee_id
            or t.center_id = any(coalesce(a.managed_locations, '{}'::text[]))
          )
        )
      )
  );
$$;
revoke all on function tms_private.can_manage_employee(text) from public, anon;
grant execute on function tms_private.can_manage_employee(text) to authenticated;

-- Remove duplicate permissive SELECT policies and replace them with one
-- organization-safe policy per table.
drop policy if exists employee_reads_authorized_profiles on public.employees;
drop policy if exists tms_admin_employee_scope on public.employees;
drop policy if exists employees_read_scope_v3 on public.employees;
create policy employees_read_scope_v3
on public.employees for select to authenticated
using (
  employee_id = (select tms_private.current_employee_id())
  or (select tms_private.can_manage_employee(employee_id))
);

drop policy if exists employee_reads_authorized_locations on public.locations;
drop policy if exists tms_admin_location_read on public.locations;
drop policy if exists locations_read_scope_v3 on public.locations;
create policy locations_read_scope_v3
on public.locations for select to authenticated
using (
  exists (
    select 1
    from public.employees me
    where me.auth_user_id = (select auth.uid())
      and me.status = 'Active'
      and me.organization_id = locations.organization_id
      and (
        me.role in ('Admin','HR','Director')
        or (
          locations.active
          and (
            locations.center_id = me.center_id
            or locations.center_id = any(coalesce(me.allowed_locations, '{}'::text[]))
            or locations.center_id = any(coalesce(me.managed_locations, '{}'::text[]))
          )
        )
      )
  )
);

-- Cover organization foreign keys and the main Workforce access patterns.
create index if not exists employees_org_status_idx
  on public.employees(organization_id, status, employee_id);
create index if not exists locations_org_active_idx
  on public.locations(organization_id, active, center_id);
create index if not exists attendance_policies_org_active_idx
  on public.attendance_policies(organization_id, active, id);
create index if not exists timesheets_org_work_date_idx
  on public.timesheets(organization_id, work_date desc, employee_id);
create index if not exists attendance_events_org_occurred_idx
  on public.attendance_events(organization_id, occurred_at desc);
create index if not exists attendance_requests_org_status_due_idx
  on public.attendance_requests(organization_id, status, due_at, employee_id);
create index if not exists attendance_requests_assigned_to_idx
  on public.attendance_requests(assigned_to) where assigned_to is not null;
create index if not exists attendance_requests_fallback_to_idx
  on public.attendance_requests(fallback_to) where fallback_to is not null;
create index if not exists shift_assignments_org_date_pub_idx
  on public.shift_assignments(organization_id, work_date, publication_status, employee_id);
create index if not exists qr_stations_org_active_idx
  on public.qr_stations(organization_id, active, station_user_id);
create index if not exists trusted_devices_org_employee_idx
  on public.trusted_devices(organization_id, employee_id, status);
create index if not exists attendance_periods_org_status_period_idx
  on public.attendance_periods(organization_id, status, period_start, period_end);

-- Organization-aware QR station creation. The short-lived QR token remains
-- hashed in attendance_qr_sessions; Workforce V3 validates the station tenant.
create or replace function public.create_attendance_qr(p_center_id text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor public.employees%rowtype;
  location_row public.locations%rowtype;
  requested_center text;
  raw_token text;
  expiry timestamptz;
  expiry_ms bigint;
  validity_seconds integer := 45;
  station_enabled boolean;
begin
  if (select auth.uid()) is null then raise exception 'Vui lòng đăng nhập.'; end if;

  select * into actor
  from public.employees
  where auth_user_id = (select auth.uid()) and status = 'Active';
  if not found then raise exception 'Không tìm thấy hồ sơ nhân viên.'; end if;
  if actor.role not in ('Admin','Director','HR','Kiosk') then
    raise exception 'Tài khoản không có quyền mở trạm QR.';
  end if;

  requested_center := coalesce(nullif(trim(p_center_id), ''), actor.center_id);
  if actor.role <> 'Admin'
    and requested_center <> actor.center_id
    and not (requested_center = any(coalesce(actor.allowed_locations, '{}'::text[]))) then
    raise exception 'Bạn chỉ được mở trạm QR tại chi nhánh đã gán.';
  end if;

  select * into location_row
  from public.locations
  where center_id = requested_center
    and organization_id = actor.organization_id
    and active;
  if not found then raise exception 'Chi nhánh chưa cấu hình vị trí hoặc ngoài tổ chức.'; end if;

  select station.active into station_enabled
  from public.qr_stations station
  where station.station_user_id = (select auth.uid())
    and station.organization_id = actor.organization_id;
  if found and not station_enabled then
    raise exception 'Trạm QR đã bị Admin vô hiệu hóa.';
  end if;

  insert into public.qr_stations(
    station_user_id, center_id, name, active, created_by, updated_at, organization_id
  ) values (
    (select auth.uid()), requested_center, 'Trạm QR - ' || location_row.center_name,
    true, actor.employee_id, clock_timestamp(), actor.organization_id
  )
  on conflict(station_user_id) do update
  set center_id = excluded.center_id,
      name = excluded.name,
      created_by = excluded.created_by,
      updated_at = excluded.updated_at,
      organization_id = excluded.organization_id;

  select least(300, greatest(15, value::integer))
  into validity_seconds
  from public.config_system
  where key = 'QR_VALIDITY_SECONDS' and value ~ '^[0-9]+$';
  validity_seconds := coalesce(validity_seconds, 45);

  raw_token := translate(encode(extensions.gen_random_bytes(24), 'base64'), E'+/\\\n', '-_');
  expiry := clock_timestamp() + make_interval(secs => validity_seconds);
  expiry_ms := floor(extract(epoch from expiry) * 1000);

  insert into public.attendance_qr_sessions(
    station_user_id, center_id, token_hash, created_by, issued_at, expires_at
  ) values (
    (select auth.uid()), requested_center,
    encode(extensions.digest(raw_token, 'sha256'), 'hex'),
    actor.employee_id, clock_timestamp(), expiry
  )
  on conflict(station_user_id) do update
  set center_id = excluded.center_id,
      token_hash = excluded.token_hash,
      created_by = excluded.created_by,
      issued_at = excluded.issued_at,
      expires_at = excluded.expires_at;

  return jsonb_build_object(
    'payload', jsonb_build_object(
      'v', 1,
      's', (select auth.uid()),
      'c', requested_center,
      't', raw_token,
      'e', expiry_ms
    )::text,
    'expiresAt', expiry_ms,
    'branchName', location_row.center_name
  );
end;
$$;
revoke all on function public.create_attendance_qr(text) from public, anon;
grant execute on function public.create_attendance_qr(text) to authenticated;

-- One browser round-trip. Each inner query still uses Workforce V3 authorization,
-- tenant scope, published schedule rules and bounded server-side pagination.
create or replace function public.tms_dashboard_bundle_v1(p_history_days integer default 120)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  today date := (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date;
  month_start date := date_trunc('month', clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date;
  history_days integer := least(120, greatest(31, coalesce(p_history_days, 120)));
  history_from date;
  request_from date := today - 180;
  request_to date := today + 180;
  bootstrap jsonb;
  history_page_1 jsonb;
  history_page_2 jsonb;
  request_me jsonb;
  request_team jsonb := jsonb_build_object('rows', '[]'::jsonb, 'total', 0, 'page', 1, 'size', 100);
  metadata jsonb;
  directory jsonb;
  capabilities jsonb;
begin
  history_from := today - (history_days - 1);

  bootstrap := public.workforce_query('bootstrap', jsonb_build_object('from', month_start, 'to', today));
  history_page_1 := public.workforce_query('history', jsonb_build_object(
    'from', history_from, 'to', today, 'scope', 'me', 'page', 1, 'size', 100
  ));
  if coalesce((history_page_1 ->> 'total')::integer, 0) > 100 then
    history_page_2 := public.workforce_query('history', jsonb_build_object(
      'from', history_from, 'to', today, 'scope', 'me', 'page', 2, 'size', 20
    ));
  else
    history_page_2 := jsonb_build_object('rows', '[]'::jsonb, 'total', 0, 'page', 2, 'size', 20);
  end if;

  request_me := public.workforce_query('requests', jsonb_build_object(
    'from', request_from, 'to', request_to, 'scope', 'me', 'page', 1, 'size', 100
  ));
  metadata := public.workforce_query('metadata', '{}'::jsonb);
  directory := public.workforce_query('directory', jsonb_build_object(
    'page', 1, 'size', 100, 'status', 'Active'
  ));

  capabilities := coalesce(bootstrap -> 'capabilities', '[]'::jsonb);
  if capabilities ? 'team.read' then
    request_team := public.workforce_query('requests', jsonb_build_object(
      'from', request_from, 'to', request_to, 'scope', 'team',
      'status', 'PENDING', 'page', 1, 'size', 100
    ));
  end if;

  return jsonb_build_object(
    'bootstrap', bootstrap,
    'history', jsonb_build_object(
      'rows', coalesce(history_page_1 -> 'rows', '[]'::jsonb) || coalesce(history_page_2 -> 'rows', '[]'::jsonb),
      'total', coalesce(history_page_1 -> 'total', '0'::jsonb)
    ),
    'requests_me', request_me,
    'requests_team', request_team,
    'metadata', metadata,
    'directory', directory
  );
end;
$$;
revoke all on function public.tms_dashboard_bundle_v1(integer) from public, anon;
grant execute on function public.tms_dashboard_bundle_v1(integer) to authenticated;

-- Retire attendance paths that can bypass Workforce V3 trusted-device,
-- tenant, idempotency, published-schedule and closed-period checks.
revoke all on function public.record_qr_attendance(text,double precision,double precision,double precision) from public, anon, authenticated;
revoke all on function public.record_qr_attendance_v2(text,double precision,double precision,double precision,text) from public, anon, authenticated;
revoke all on function public.checkout_attendance_gps(double precision,double precision,double precision) from public, anon, authenticated;
revoke all on function public.record_mobile_checkin(double precision,double precision,double precision,text,text,text) from public, anon, authenticated;
revoke all on function public.record_mobile_checkout(double precision,double precision,double precision) from public, anon, authenticated;
revoke all on function public.record_kiosk_checkin(text,text,double precision,double precision,double precision,text) from public, anon, authenticated;
revoke all on function public.toggle_attendance_pause() from public, anon, authenticated;
revoke all on function public.toggle_attendance_pause(boolean) from public, anon, authenticated;
revoke all on function public.get_my_attendance() from public, anon, authenticated;
revoke all on function public.get_my_tms_v2() from public, anon, authenticated;
revoke all on function public.sync_my_timesheet_v2() from public, anon, authenticated;
revoke all on function public.submit_attendance_explanation(date,text) from public, anon, authenticated;
revoke all on function public.review_attendance_explanation(uuid,text,text) from public, anon, authenticated;
revoke all on function public.register_or_validate_trusted_device(text) from public, anon, authenticated;

notify pgrst, 'reload schema';
commit;