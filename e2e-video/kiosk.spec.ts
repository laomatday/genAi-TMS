import { expect, test } from '@playwright/test';
import { mockBackend } from '../e2e/support/backend';

/** The wall screen, in its own file so the phone run never re-records it. */
test('20-kiosk', async ({ page }) => {
  await mockBackend(page);
  await page.goto('/');
  await page.getByLabel('Tài khoản').fill('admin@example.com');
  await page.locator('#login-password').fill('correct-password');
  await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page.locator('#login-account')).toBeHidden({ timeout: 15_000 });

  await page.goto('/kiosk');
  await expect(page.locator('svg').first()).toBeVisible({ timeout: 20_000 });
  // Nothing to drive: the code rotates and the countdown drains on their own.
  // Minted with 38 seconds left, so this covers a full drain and the roll.
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(45_000);
});
