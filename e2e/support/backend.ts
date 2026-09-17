import { expect, type Page } from '@playwright/test';

/**
 * A complete stand-in for the Supabase backend, shared by the navigation tests
 * and the screenshot capture.
 *
 * Every screen in the app is fed from `workforce_query`, so intercepting that
 * one endpoint (plus auth and the trusted-device function) is enough to drive
 * the whole product without a server, an account, or a single row of real
 * employee data leaving the database.
 */

const AUTH_USER_ID = '10000000-0000-4000-8000-000000000001';
const ORGANIZATION_ID = '20000000-0000-4000-8000-000000000001';
const EMPLOYEE_ID = 'EMP-E2E';
// The app works in Asia/Ho_Chi_Minh. Taking the UTC date instead puts the mock
// a day behind for the seven hours after midnight local, and today's row then
// fails to match — which is why the home screen showed "Chưa vào ca" while the
// mock was serving an open shift.
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date());

function shiftDay(days: number) {
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function token() {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: AUTH_USER_ID, role: 'authenticated', exp: 4_102_444_800 })}.e2e`;
}

const authUser = {
  id: AUTH_USER_ID,
  aud: 'authenticated',
  role: 'authenticated',
  email: 'admin@example.com',
  email_confirmed_at: '2026-01-01T00:00:00Z',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  app_metadata: { provider: 'email', providers: ['email'] },
  user_metadata: {},
};

/** Invented people. No name here belongs to anyone in the real directory. */
const DIRECTORY = [
  { employee_id: EMPLOYEE_ID, name: 'Nhân sự E2E', position: 'Quản trị hệ thống', department: 'Vận hành', role: 'Admin' },
  { employee_id: 'EMP-0002', name: 'Trần Minh Khoa', position: 'Chuyên viên tư vấn', department: 'Kinh doanh', role: 'Staff' },
  { employee_id: 'EMP-0003', name: 'Lê Thu Hà', position: 'Trưởng nhóm', department: 'Kinh doanh', role: 'Leader' },
  { employee_id: 'EMP-0004', name: 'Phạm Quốc Duy', position: 'Kỹ thuật viên', department: 'Kỹ thuật', role: 'Staff' },
  { employee_id: 'EMP-0005', name: 'Vũ Ngọc Lan', position: 'Nhân sự', department: 'Hành chính', role: 'HR' },
];

function timesheet(offset: number, overrides: Record<string, unknown> = {}) {
  const date = shiftDay(-offset);
  return {
    id: `ts-${offset}`,
    employee_id: EMPLOYEE_ID,
    employee_name: 'Nhân sự E2E',
    work_date: date,
    business_date: date,
    actual_checkin: `${date}T01:28:00Z`,
    actual_checkout: `${date}T10:34:00Z`,
    work_minutes: 546,
    late_minutes: 0,
    break_minutes: 60,
    status: 'COMPLETE',
    location_id: 'DN01',
    location_name: 'Đà Nẵng 1',
    exception_codes: [],
    updated_at: `${date}T10:34:00Z`,
    ...overrides,
  };
}

function workforcePayload(resource: string) {
  // Mirrors what wf_private.query_commercial attaches to every paged response:
  // a short leash on the things that move, five minutes on reference data.
  // Without it the mock understates how much the client can cache.
  const page = (rows: object[] = []) => ({
    rows,
    total: rows.length,
    has_more: false,
    next_cursor: null,
    cache: {
      resource,
      ttl_seconds: ['history', 'requests', 'admin.audit'].includes(resource) ? 30 : 300,
    },
  });

  if (resource === 'bootstrap') {
    return {
      profile: {
        employee_id: EMPLOYEE_ID,
        auth_user_id: AUTH_USER_ID,
        organization_id: ORGANIZATION_ID,
        name: 'Nhân sự E2E',
        email: 'admin@example.com',
        role: 'Admin',
        position: 'Quản trị hệ thống',
        department: 'Vận hành',
        center_id: 'DN01',
        status: 'Active',
        annual_leave_balance: 12,
        managed_locations: ['DN01'],
        allowed_locations: ['DN01'],
      },
      policy: { name: 'Ca hành chính', work_days: [1, 2, 3, 4, 5], late_tolerance_minutes: 5, expected_start: '08:30:00', expected_end: '17:30:00' },
      summary: { days: 18, exceptions: 1, remaining_leave: 9 },
      capabilities: [
        'attendance.self', 'team.read', 'team.read_all', 'attendance.review',
        'attendance.export', 'attendance.lock_period', 'directory.read',
        'employee.manage', 'schedule.manage', 'settings.manage',
        'kiosk.manage', 'audit.view', 'request.submit',
      ],
      timezone: 'Asia/Ho_Chi_Minh',
      local_date: today,
      server_time: `${today}T08:00:00+07:00`,
      unread: 1,
      // An open shift: checked in this morning, not yet out. The home screen
      // then shows a running timer and the check-out path, which is the state
      // an employee is actually in for most of the day.
      today: {
        id: 'ts-open',
        employee_id: EMPLOYEE_ID,
        work_date: today,
        business_date: today,
        actual_checkin: `${today}T01:28:00Z`,
        actual_checkout: null,
        work_minutes: 0,
        late_minutes: 0,
        break_minutes: 0,
        status: 'OPEN',
        location_id: 'DN01',
        location_name: 'Đà Nẵng 1',
        exception_codes: [],
      },
    };
  }

  if (resource === 'metadata') {
    return {
      shifts: [{ id: 1, name: 'Ca hành chính', start_time: '08:30:00', end_time: '17:30:00', break_point: '17:30:00' }],
      locations: [{ center_id: 'DN01', center_name: 'Đà Nẵng 1', address: 'Đà Nẵng', latitude: 16.05, longitude: 108.2, radius_meters: 200, active: true }],
      location_directory: [{ center_id: 'DN01', center_name: 'Đà Nẵng 1', active: true }],
      holidays: [],
      system_settings: [],
      cache: { ttl_seconds: 30 },
    };
  }

  if (resource === 'history') {
    return page([
      timesheet(0, { actual_checkout: null, work_minutes: 0, status: 'OPEN' }),
      timesheet(1),
      timesheet(2, { actual_checkin: `${shiftDay(-2)}T01:47:00Z`, late_minutes: 17, status: 'EXCEPTION', exception_codes: ['LATE'] }),
      timesheet(3),
      timesheet(4),
      timesheet(5),
    ]);
  }

  if (resource === 'requests') {
    return page([
      {
        id: 'req-1',
        request_code: 'REQ-000101',
        employee_id: EMPLOYEE_ID,
        employee_name: 'Nhân sự E2E',
        request_type: 'TIME_OFF',
        from_date: shiftDay(6),
        to_date: shiftDay(8),
        reason: 'Nghỉ phép năm, đã bàn giao công việc cho nhóm.',
        status: 'PENDING',
        assigned_to: 'EMP-0003',
        revision: 1,
        due_at: `${shiftDay(1)}T10:00:00Z`,
        created_at: `${shiftDay(-1)}T03:12:00Z`,
      },
      {
        id: 'req-2',
        request_code: 'REQ-000098',
        employee_id: EMPLOYEE_ID,
        employee_name: 'Nhân sự E2E',
        request_type: 'EXPLANATION',
        from_date: shiftDay(-2),
        to_date: shiftDay(-2),
        reason: 'Kẹt xe trên đường Nguyễn Văn Linh, đến muộn 17 phút.',
        status: 'APPROVED',
        revision: 1,
        manager_note: 'Đã ghi nhận.',
        created_at: `${shiftDay(-2)}T04:00:00Z`,
      },
    ]);
  }

  if (resource === 'directory') {
    return page(DIRECTORY.map((person, index) => ({
      ...person,
      internal_id: `00000000-0000-4000-8000-00000000000${index + 1}`,
      employee_code: person.employee_id,
      email: `${person.employee_id.toLowerCase()}@example.com`,
      phone: '0900000000',
      center_id: 'DN01',
      status: 'Active',
      avatar_url: null,
      direct_manager_id: person.employee_id === EMPLOYEE_ID ? null : EMPLOYEE_ID,
    })));
  }

  if (resource === 'schedule') {
    return page([0, 1, 2, 3, 4].map((offset) => ({
      id: `sa-${offset}`,
      employee_id: EMPLOYEE_ID,
      employee_name: 'Nhân sự E2E',
      work_date: shiftDay(offset),
      shift_name: 'Ca hành chính',
      start_time: '08:30:00',
      end_time: '17:30:00',
      location_id: 'DN01',
      location_name: 'Đà Nẵng 1',
      publication_status: 'PUBLISHED',
      note: '',
    })));
  }

  if (resource === 'inbox') {
    return page([
      {
        id: 'ntf-1',
        kind: 'REQUEST_PENDING',
        title: 'Đề xuất đã được duyệt',
        body: 'Đơn giải trình ngày ' + shiftDay(-2) + ' đã được phê duyệt.',
        context: {},
        created_at: `${today}T02:10:00Z`,
        read_at: null,
      },
      {
        id: 'ntf-2',
        kind: 'GENERAL',
        title: 'Chào mừng',
        body: 'Hộp thư thông báo dùng dữ liệu máy chủ.',
        context: {},
        created_at: `${today}T01:00:00Z`,
        read_at: `${today}T01:30:00Z`,
      },
    ]);
  }

  // ---- Control Center ------------------------------------------------------
  // The admin screens read a different set of resources from the employee app.

  if (resource === 'admin.config') {
    return {
      config_revision: 4,
      locations: [
        { center_id: 'DN01', center_name: 'Đà Nẵng 1', address: '123 Nguyễn Văn Linh, Đà Nẵng', city: 'Đà Nẵng', latitude: 16.05, longitude: 108.2, radius_meters: 200, active: true },
        { center_id: 'HN01', center_name: 'Hà Nội 1', address: '45 Trần Duy Hưng, Hà Nội', city: 'Hà Nội', latitude: 21.01, longitude: 105.79, radius_meters: 200, active: true },
      ],
      policies: [{ id: 1, name: 'Ca hành chính', expected_start: '08:30:00', expected_end: '17:30:00', work_days: [1, 2, 3, 4, 5], late_tolerance_minutes: 5, active: true }],
      stations: [
        { id: 'st-1', center_id: 'DN01', name: 'Kiosk sảnh Đà Nẵng 1', active: true, updated_at: new Date().toISOString() },
        { id: 'st-2', center_id: 'HN01', name: 'Kiosk sảnh Hà Nội 1', active: true, updated_at: `${shiftDay(-1)}T02:00:00Z` },
      ],
      shifts: [
        { id: 1, name: 'Ca hành chính', start_time: '08:30:00', end_time: '17:30:00', sort_order: 1, active: true },
        { id: 2, name: 'Ca sáng', start_time: '06:00:00', end_time: '12:00:00', sort_order: 2, active: true },
        { id: 3, name: 'Ca tối', start_time: '17:00:00', end_time: '22:00:00', sort_order: 3, active: true },
      ],
      systemSettings: [
        { key: 'APPROVAL_ROLES', value: '{"leave":["Manager","HR","Admin"],"attendance":["Manager","HR","Admin"]}' },
        { key: 'DEVICE_LOCK_ROLES', value: '["Staff","Leader","Manager","Director"]' },
      ],
      holidays: [{ id: 1, name: 'Quốc khánh', from_date: `${today.slice(0, 4)}-09-02`, to_date: `${today.slice(0, 4)}-09-02`, active: true }],
      attendancePeriods: [],
      features: { workforceOperations: true },
    };
  }

  if (resource === 'admin.people') {
    return page(DIRECTORY.map((person, index) => ({
      ...person,
      id: person.employee_id,
      internal_id: `00000000-0000-4000-8000-00000000000${index + 1}`,
      employee_code: person.employee_id,
      email: `${person.employee_id.toLowerCase()}@example.com`,
      phone: '0900000000',
      center_id: index % 2 === 0 ? 'DN01' : 'HN01',
      status: 'Active',
      annual_leave_balance: 12,
      device_lock_required: person.role !== 'Admin' && person.role !== 'HR',
      capability_overrides: {},
      direct_manager_id: person.employee_id === EMPLOYEE_ID ? null : EMPLOYEE_ID,
    })));
  }

  if (resource === 'admin.sessions') {
    return page(DIRECTORY.flatMap((person, index) => [0, 1, 2].map((offset) => ({
      ...timesheet(offset, {
        id: `sess-${index}-${offset}`,
        employee_id: person.employee_id,
        employee_name: person.name,
        location_id: index % 2 === 0 ? 'DN01' : 'HN01',
        status: offset === 2 && index === 1 ? 'NEEDS_REVIEW' : 'COMPLETE',
      }),
      created_at: `${shiftDay(-offset)}T10:34:00Z`,
      session_sequence: 1,
      source: 'QR',
    }))));
  }

  if (resource === 'admin.requests') {
    return page([{
      id: 'areq-1',
      request_code: 'REQ-000104',
      employee_id: 'EMP-0004',
      employee_name: 'Phạm Quốc Duy',
      request_type: 'EXPLANATION',
      from_date: shiftDay(-1),
      to_date: shiftDay(-1),
      reason: 'Quên quét mã khi ra về, nhờ quản lý xác nhận giúp.',
      status: 'PENDING',
      revision: 1,
      created_at: `${shiftDay(-1)}T11:00:00Z`,
    }]);
  }

  if (resource === 'admin.devices') {
    return page(DIRECTORY.slice(0, 3).map((person, index) => ({
      device_id: `device-${index}`,
      employee_id: person.employee_id,
      employee_name: person.name,
      device_label: index === 0 ? 'Pixel 8' : 'iPhone 15',
      status: 'ACTIVE',
      activated_at: `${shiftDay(-10 + index)}T02:00:00Z`,
      last_seen_at: `${today}T01:00:00Z`,
    })));
  }

  if (resource === 'admin.audit') {
    return page([
      { id: 'au-1', action: 'EMPLOYEE_UPDATED', entity: 'employee', entity_id: 'EMP-0003', actor_employee_id: EMPLOYEE_ID, reason: 'Cập nhật chi nhánh', created_at: `${today}T02:40:00Z`, context: {} },
      { id: 'au-2', action: 'REQUEST_REVIEWED', entity: 'attendance_request', entity_id: 'REQ-000098', actor_employee_id: EMPLOYEE_ID, reason: 'Đã ghi nhận', created_at: `${shiftDay(-1)}T08:15:00Z`, context: {} },
      { id: 'au-3', action: 'SHIFT_PUBLISHED', entity: 'shift_assignment', entity_id: 'sa-0', actor_employee_id: EMPLOYEE_ID, reason: 'Công bố lịch tuần', created_at: `${shiftDay(-2)}T04:05:00Z`, context: {} },
    ]);
  }

  if (resource === 'admin.schedule') {
    return page(DIRECTORY.flatMap((person, index) => [0, 1, 2, 3, 4].map((offset) => ({
      id: `asa-${index}-${offset}`,
      employee_id: person.employee_id,
      employee_name: person.name,
      work_date: shiftDay(offset),
      shift_id: 1,
      shift_name: 'Ca hành chính',
      start_time: '08:30:00',
      end_time: '17:30:00',
      location_id: index % 2 === 0 ? 'DN01' : 'HN01',
      location_name: index % 2 === 0 ? 'Đà Nẵng 1' : 'Hà Nội 1',
      publication_status: 'PUBLISHED',
      note: '',
    }))));
  }

  return page();
}

export async function mockBackend(
  page: Page,
  trustedDeviceResponse: Record<string, unknown> = {
    ok: true,
    state: 'VERIFIED',
    expiresAt: '2099-01-01T00:00:00.000Z',
  },
  trustedDeviceStatus = 200,
) {
  await page.route('https://e2e.supabase.invalid/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const headers = {
      'access-control-allow-origin': '*',
      'content-type': 'application/json',
    };
    if (url.pathname.endsWith('/auth/v1/token')) {
      await route.fulfill({ status: 200, headers, json: { access_token: token(), refresh_token: 'e2e-refresh', expires_in: 86_400, expires_at: 4_102_444_800, token_type: 'bearer', user: authUser } });
      return;
    }
    if (url.pathname.endsWith('/auth/v1/user')) {
      await route.fulfill({ status: 200, headers, json: authUser });
      return;
    }
    if (url.pathname.endsWith('/auth/v1/logout')) {
      await route.fulfill({ status: 204, headers });
      return;
    }
    if (url.pathname.endsWith('/functions/v1/trusted-device')) {
      await route.fulfill({ status: trustedDeviceStatus, headers, json: trustedDeviceResponse });
      return;
    }
    if (url.pathname.endsWith('/rest/v1/rpc/workforce_query')) {
      const body = request.postDataJSON() as { p_resource?: string };
      await route.fulfill({ status: 200, headers, json: workforcePayload(body.p_resource || '') });
      return;
    }
    if (url.pathname.endsWith('/rest/v1/rpc/create_attendance_qr')) {
      await route.fulfill({
        status: 200,
        headers,
        json: {
          // Shaped like the real token so the rendered QR has realistic density.
          payload: `genai-tms:v4:DN01:${'8f2a41c7d9e3b605'.repeat(2)}:${Date.now()}`,
          // Inside the validity window the station reads from metadata, so the
          // countdown bar shows a real fraction instead of pinning at full.
          expiresAt: Date.now() + 38_000,
          branchName: 'Đà Nẵng 1',
        },
      });
      return;
    }
    if (url.pathname.endsWith('/rest/v1/rpc/workforce_command')) {
      const body = request.postDataJSON() as { p_action?: string; p_args?: { action?: string } };
      // An attendance command is only accepted by the app if it comes back with
      // a receipt; without one it reports "Hệ thống chưa trả về biên nhận
      // chấm công" and the scan looks broken. The real command returns one, so
      // the mock does too.
      if (body?.p_action === 'attendance') {
        const action = body.p_args?.action === 'checkout' ? 'checkout' : body.p_args?.action || 'checkin';
        await route.fulfill({
          status: 200,
          headers,
          json: {
            ok: true,
            receipt: {
              id: 'e2e-receipt-0001',
              event_id: 'e2e-event-0001',
              action,
              occurred_at: new Date().toISOString(),
              work_date: today,
              location_name: 'Đà Nẵng 1',
              gps_accuracy_m: 12,
              device_verified: true,
              status: 'OPEN',
            },
          },
        });
        return;
      }
      await route.fulfill({ status: 200, headers, json: { ok: true, count: 1 } });
      return;
    }
    await route.fulfill({ status: 200, headers, json: null });
  });
}

/** Signs in and lands on the employee app, whichever entry the role gets. */
export async function openEmployeeApp(page: Page) {
  await mockBackend(page);
  await page.goto('/');
  await page.getByLabel('Tài khoản').fill('admin@example.com');
  await page.locator('#login-password').fill('correct-password');
  await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page.locator('#login-account')).toBeHidden({ timeout: 15_000 });
  const employeeNavigation = page.getByRole('navigation', { name: 'Điều hướng chính' });
  const attendanceWorkspace = page.getByRole('link', { name: /Chấm công/ });
  await expect(employeeNavigation.or(attendanceWorkspace)).toBeVisible({ timeout: 15_000 });
  if (await attendanceWorkspace.isVisible()) await attendanceWorkspace.click();
  await expect(employeeNavigation).toBeVisible({ timeout: 15_000 });
}
