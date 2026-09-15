import { expect, test } from '@playwright/test';
import { openEmployeeApp } from './support/backend';
import { STALE_RELOAD_MARKER } from '../src/core/errors/staleBuild';

/**
 * Reproduces what a deploy does to a tab that is already open: the route's
 * module is no longer served, so the dynamic import behind React.lazy rejects.
 *
 * Production showed exactly this after every deploy — an unhandled rejection
 * followed by a render error, and the error screen's "Thử lại" only re-rendered,
 * which threw again.
 *
 * The automatic reload is spent up front by seeding the cooldown marker, so what
 * is under test here is the screen a user lands on when recovery has already
 * been attempted: it must name the real cause and offer a way out, not the
 * generic crash copy.
 */
test('a module lost to a deploy is reported as a stale build, not a crash', async ({ page }) => {
  await page.addInitScript((key) => {
    try { window.sessionStorage.setItem(key, String(Date.now())); } catch { /* private mode */ }
  }, STALE_RELOAD_MARKER);

  await openEmployeeApp(page);

  const blocked = page.waitForRequest((request) => request.url().includes('/Calendar'));
  await page.route('**/Calendar*', (route) => route.fulfill({ status: 404, body: 'gone' }));

  await page.getByRole('button', { name: 'Lịch', exact: true }).last().click();
  await blocked;

  await expect(page.getByText('Ứng dụng vừa được cập nhật')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('button', { name: 'Cập nhật ngay' })).toBeVisible();
  // The generic wording would send the user to support for something that
  // clears itself with a reload.
  await expect(page.getByText('gửi mã sự cố cho bộ phận hỗ trợ')).toBeHidden();
});
