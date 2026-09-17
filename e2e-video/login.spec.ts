import { expect, test } from '@playwright/test';
import { mockBackend } from '../e2e/support/backend';

/** The one clip that runs without a session, which is why it is on its own. */
test('01-dang-nhap', async ({ page }) => {
  await mockBackend(page);
  await page.goto('/');
  await expect(page.locator('#login-account')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1_200);

  // Typed rather than filled. `fill` sets the value in one frame, which reads
  // as the field being pasted into by a machine.
  await page.getByLabel('Tài khoản').pressSequentially('an.nguyen@genai.vn', { delay: 75 });
  await page.waitForTimeout(500);
  await page.locator('#login-password').pressSequentially('aaaaaaaa', { delay: 75 });
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: 'Đăng nhập' }).click();

  await expect(page.locator('#login-account')).toBeHidden({ timeout: 15_000 });
  // Held past the handover so the clip ends on the home screen it lands on,
  // which is where the next clip picks up.
  await page.waitForTimeout(2_600);
});
