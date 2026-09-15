import { expect, test } from '@playwright/test';
import { mockBackend, openEmployeeApp } from './support/backend';

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
