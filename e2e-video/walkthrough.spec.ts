import { expect, test, type Page } from '@playwright/test';
import { mockBackend } from '../e2e/support/backend';
import { swipeTab } from './support/gestures';

/**
 * Two recordings, against the same mocked backend the screenshots use: no
 * credentials, no production data, invented names.
 *
 * Everything here is paced for a viewer rather than for a test runner. A test
 * wants to finish; a recording wants the reader to keep up, so text is typed a
 * character at a time and each screen is held long enough to be read.
 */

/** Long enough to register as a pause, short enough not to feel like a stall. */
const BEAT = 900;
const READ = 1_800;

async function settle(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(BEAT);
}

test.describe('employee app', () => {
  test.skip(({ isMobile }) => !isMobile, 'phone recording only');

  test('a day on the phone', async ({ page }) => {
    await mockBackend(page);
    await page.goto('/');
    await expect(page.locator('#login-account')).toBeVisible();
    await settle(page);

    // Typed rather than filled. `fill` sets the value in one frame, which on
    // film reads as the field being pasted into by a machine.
    await page.getByLabel('Tài khoản').pressSequentially('an.nguyen@genai.vn', { delay: 70 });
    await page.waitForTimeout(400);
    await page.locator('#login-password').pressSequentially('••••••••'.replace(/•/g, 'a'), { delay: 70 });
    await page.waitForTimeout(BEAT);
    await page.getByRole('button', { name: 'Đăng nhập' }).click();

    const navigation = page.getByRole('navigation', { name: 'Điều hướng chính' });
    const workspace = page.getByRole('link', { name: /Chấm công/ });
    await expect(navigation.or(workspace)).toBeVisible({ timeout: 15_000 });
    if (await workspace.isVisible()) await workspace.click();
    await expect(navigation).toBeVisible({ timeout: 15_000 });
    await settle(page);
    await page.waitForTimeout(READ);

    // Two different movements, filmed as two different things, because that is
    // how the app actually behaves: a swipe inside a page moves between that
    // page's own views and only changes tab once it runs out of them. Driving
    // the whole tour by swiping films the same screen several times over while
    // the sub-views cycle, which reads as a stuck recording.
    //
    // So: tap to change tab, swipe to show what a tab holds.
    for (const label of ['Chấm công', 'Đề xuất', 'Danh bạ']) {
      await page.getByRole('button', { name: label, exact: true }).last().click();
      await page.waitForTimeout(READ);

      await swipeTab(page, 'left');
      await page.waitForTimeout(READ);
      await swipeTab(page, 'right');
      await page.waitForTimeout(BEAT);
    }

    // The calendar is worth its own beat: it is the one screen people read
    // rather than operate.
    await page.getByRole('button', { name: 'Lịch', exact: true }).last().click();
    await page.waitForTimeout(READ + BEAT);

    // Filing a request: the screen most people will open in the first week.
    await page.getByRole('button', { name: 'Đề xuất', exact: true }).last().click();
    await page.waitForTimeout(READ);
    await page.getByRole('button', { name: 'Tạo đề xuất mới' }).click();
    await expect(page.locator('[role="dialog"]')).toBeVisible();
    await page.waitForTimeout(READ + BEAT);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(BEAT);

    // And the inbox, which is where an approval comes back.
    await page.getByRole('button', { name: 'Trang chủ', exact: true }).last().click();
    await page.waitForTimeout(BEAT);
    await page.getByRole('button', { name: /Thông báo/ }).first().click();
    await page.waitForTimeout(READ + BEAT);
  });
});

test.describe('kiosk station', () => {
  test.skip(({ isMobile }) => Boolean(isMobile), 'wall screen only');

  test('the code on the wall', async ({ page }) => {
    await mockBackend(page);
    await page.goto('/');
    await page.getByLabel('Tài khoản').fill('admin@example.com');
    await page.locator('#login-password').fill('correct-password');
    await page.getByRole('button', { name: 'Đăng nhập' }).click();
    await expect(page.locator('#login-account')).toBeHidden({ timeout: 15_000 });

    await page.goto('/kiosk');
    await expect(page.locator('svg').first()).toBeVisible({ timeout: 20_000 });
    // The station's whole point is the rotating code and the countdown draining
    // beneath it, so this one is held rather than driven: there is nothing to
    // click, and the thing worth filming happens on its own. The code is minted
    // with 38 seconds left, so this covers a full drain and the roll after it.
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(45_000);
  });
});
