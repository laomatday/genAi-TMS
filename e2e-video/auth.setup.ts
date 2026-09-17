import { expect, test as setup } from '@playwright/test';
import { mockBackend } from '../e2e/support/backend';
import { AUTH_STATE } from './support/paths';

/**
 * Signs in once and keeps the session on disk.
 *
 * Every clip used to sign in on camera, so each one opened on the login screen
 * flashing past before the screen it was meant to show. The scenario asks for
 * the opposite: sign in once at the start, then move through the app as one
 * continuous session.
 *
 * Playwright films a whole context, so there is no way to sign in off camera
 * within a clip. Doing it here instead, in a run that records nothing, means
 * the app clips open already inside the app.
 */
setup('authenticate', async ({ page }) => {
  await mockBackend(page);
  await page.goto('/');
  await page.getByLabel('Tài khoản').fill('an.nguyen@genai.vn');
  await page.locator('#login-password').fill('correct-password');
  await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page.locator('#login-account')).toBeHidden({ timeout: 15_000 });

  const navigation = page.getByRole('navigation', { name: 'Điều hướng chính' });
  const workspace = page.getByRole('link', { name: /Chấm công/ });
  await expect(navigation.or(workspace)).toBeVisible({ timeout: 15_000 });
  if (await workspace.isVisible()) await workspace.click();
  await expect(navigation).toBeVisible({ timeout: 15_000 });

  await page.context().storageState({ path: AUTH_STATE });
});
