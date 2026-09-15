import { expect, test, type Page } from '@playwright/test';

const AUTH_USER_ID = '10000000-0000-4000-8000-000000000001';
const ORGANIZATION_ID = '20000000-0000-4000-8000-000000000001';
const EMPLOYEE_ID = 'EMP-E2E';
const today = new Date().toISOString().slice(0, 10);

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

function workforcePayload(resource: string) {
  const page = (rows: object[] = []) => ({ rows, total: rows.length, has_more: false, next_cursor: null });
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
      policy: { name: 'Ca hành chính', work_days: [1, 2, 3, 4, 5], late_tolerance_minutes: 5 },
      summary: { days: 0, exceptions: 0, remaining_leave: 12 },
      capabilities: ['attendance.self', 'team.read', 'attendance.review', 'directory.read', 'schedule.manage', 'settings.manage'],
      timezone: 'Asia/Ho_Chi_Minh',
      local_date: today,
      server_time: `${today}T08:00:00+07:00`,
      unread: 1,
      today: null,
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
  if (resource === 'schedule') {
    return page([{
      id: '30000000-0000-4000-8000-000000000001',
      employee_id: EMPLOYEE_ID,
      work_date: today,
      shift_name: 'Ca hành chính',
      start_time: '08:30:00',
      end_time: '17:30:00',
      location_id: 'DN01',
      location_name: 'Đà Nẵng 1',
      publication_status: 'PUBLISHED',
      note: '',
    }]);
  }
  if (resource === 'inbox') {
    return page([{
      id: '40000000-0000-4000-8000-000000000001',
      kind: 'GENERAL',
      title: 'Chào mừng',
      body: 'Hộp thư thông báo dùng dữ liệu máy chủ.',
      context: {},
      created_at: `${today}T01:00:00Z`,
      read_at: null,
    }]);
  }
  return page();
}

async function mockBackend(
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
      await route.fulfill({
        status: trustedDeviceStatus,
        headers,
        json: trustedDeviceResponse,
      });
      return;
    }
    if (url.pathname.endsWith('/rest/v1/rpc/workforce_query')) {
      const body = request.postDataJSON() as { p_resource?: string };
      await route.fulfill({ status: 200, headers, json: workforcePayload(body.p_resource || '') });
      return;
    }
    if (url.pathname.endsWith('/rest/v1/rpc/workforce_command')) {
      await route.fulfill({ status: 200, headers, json: { ok: true, count: 1 } });
      return;
    }
    await route.fulfill({ status: 200, headers, json: null });
  });
}

test('a different trusted device is blocked with the server message', async ({ page }) => {
  await mockBackend(page, {
    ok: false,
    state: 'BLOCKED',
    error: 'Tài khoản đang liên kết với thiết bị khác.',
  }, 403);
  await page.goto('/');
  await page.getByLabel('Tài khoản').fill('admin@example.com');
  await page.locator('#login-password').fill('correct-password');
  await page.getByRole('button', { name: 'Đăng nhập' }).click();

  await expect(page.getByRole('heading', { name: 'Thiết bị chưa được xác thực' })).toBeVisible();
  await expect(page.getByText('Tài khoản đang liên kết với thiết bị khác.', { exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Điều hướng chính' })).toBeHidden();
});

async function openEmployeeApp(page: Page) {
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

test('navigation and page tabs are represented in browser history', async ({ page }) => {
  await openEmployeeApp(page);

  await page.getByRole('button', { name: 'Đề xuất', exact: true }).last().click();
  await expect(page).toHaveURL(/tab=requests/);
  await expect(page.getByRole('heading', { name: 'Đề xuất' })).toBeVisible();
  await page.getByRole('button', { name: /Giải trình/ }).first().click();
  await expect(page).toHaveURL(/requestView=explanations/);
  await page.goBack();
  await expect(page).not.toHaveURL(/requestView=explanations/);

  await page.getByRole('button', { name: 'Lịch', exact: true }).last().click();
  await expect(page).toHaveURL(/tab=calendar/);
  await expect(page.getByRole('tab', { name: /Ca của tôi/ })).toBeVisible();
  await expect(page.getByText('Ca hành chính', { exact: true }).last()).toBeVisible();
});

test('browser Back closes the top modal before leaving its page', async ({ page }) => {
  await openEmployeeApp(page);
  await page.getByRole('button', { name: 'Đề xuất', exact: true }).last().click();
  await page.getByRole('button', { name: 'Tạo đề xuất mới' }).click();
  const requestDialog = page.locator('[role="dialog"][aria-labelledby="create-request-title"]');
  await expect(requestDialog).toBeVisible();
  await expect(page).toHaveURL(/modal=request/);

  await page.goBack();
  await expect(requestDialog).toBeHidden();
  await expect(page).toHaveURL(/tab=requests/);
  await expect(page.getByRole('heading', { name: 'Đề xuất' })).toBeVisible();
});

test('settings is keyboard reachable, traps focus, and closes with Escape', async ({ page }) => {
  await openEmployeeApp(page);
  const menuButton = page.getByRole('button', { name: 'Mở menu tác vụ' });
  await menuButton.focus();
  await page.keyboard.press('Enter');
  const settingsItem = page.getByRole('menuitem', { name: 'Cài đặt' });
  await settingsItem.focus();
  await page.keyboard.press('Enter');

  const settingsDialog = page.getByRole('dialog', { name: 'Cài đặt' });
  await expect(settingsDialog).toBeVisible();
  await expect(page).toHaveURL(/modal=settings/);
  await expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')))).toBe(true);

  await page.getByRole('button', { name: /Hướng dẫn sử dụng/ }).click();
  await expect(page).toHaveURL(/modal=settings-guide/);
  await expect(page.getByRole('heading', { name: 'Chấm công 4.0' })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Chấm công 4.0' })).toBeHidden();
  await expect(settingsDialog).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(settingsDialog).toBeHidden();
  await expect(page).not.toHaveURL(/modal=settings/);
});

test('the employee app reflows without page-level horizontal scrolling', async ({ page }) => {
  await openEmployeeApp(page);
  await page.setViewportSize({ width: 320, height: 800 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.getByRole('button', { name: 'Lịch', exact: true }).last().click();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
