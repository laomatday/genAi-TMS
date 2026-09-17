import { expect, test, type Page } from '@playwright/test';
import { mockBackend } from '../e2e/support/backend';
import { swipeTab } from './support/gestures';

/**
 * One clip per screen, against the same mocked backend the screenshots use: no
 * credentials, no production data, invented names.
 *
 * Separate clips rather than one continuous walkthrough, because the edit
 * happens outside this repo. A single take forces whoever is cutting it to
 * find the boundaries again and trim around them; separate takes hand over the
 * boundaries already made, in order, each one starting on a settled screen.
 *
 * Playwright writes one video per test, named after the test, so the test
 * titles are the delivered filenames and the numbering is the running order.
 *
 * Everything is paced for a viewer rather than a test runner. A test wants to
 * finish; a clip wants the reader to keep up.
 */

const BEAT = 700;
const READ = 1_800;

async function settle(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(BEAT);
}

/** Signs in and waits out the entry animation, so a clip opens on a still app. */
async function arrive(page: Page) {
  await mockBackend(page);
  await page.goto('/');
  await page.getByLabel('Tài khoản').fill('an.nguyen@genai.vn');
  await page.locator('#login-password').fill('correct-password');
  await page.getByRole('button', { name: 'Đăng nhập' }).click();

  const navigation = page.getByRole('navigation', { name: 'Điều hướng chính' });
  const workspace = page.getByRole('link', { name: /Chấm công/ });
  await expect(navigation.or(workspace)).toBeVisible({ timeout: 15_000 });
  if (await workspace.isVisible()) await workspace.click();
  await expect(navigation).toBeVisible({ timeout: 15_000 });
  await settle(page);
}

/** Opens a tab from the bottom bar and lets it come to rest. */
async function openTab(page: Page, label: string) {
  await page.getByRole('button', { name: label, exact: true }).last().click();
  await page.waitForTimeout(READ);
}

test.describe('phone', () => {
  test.skip(({ isMobile }) => !isMobile, 'phone clips only');

  test('01-dang-nhap', async ({ page }) => {
    await mockBackend(page);
    await page.goto('/');
    await expect(page.locator('#login-account')).toBeVisible();
    await settle(page);
    await page.waitForTimeout(BEAT);

    // Typed rather than filled. `fill` sets the value in one frame, which reads
    // as the field being pasted into by a machine.
    await page.getByLabel('Tài khoản').pressSequentially('an.nguyen@genai.vn', { delay: 75 });
    await page.waitForTimeout(400);
    await page.locator('#login-password').pressSequentially('aaaaaaaa', { delay: 75 });
    await page.waitForTimeout(BEAT);
    await page.getByRole('button', { name: 'Đăng nhập' }).click();
    await expect(page.locator('#login-account')).toBeHidden({ timeout: 15_000 });
    await page.waitForTimeout(READ);
  });

  test('02-trang-chu', async ({ page }) => {
    await arrive(page);
    await page.waitForTimeout(READ * 2);
  });

  test('03-cham-cong', async ({ page }) => {
    await arrive(page);
    await openTab(page, 'Chấm công');
    // A swipe inside a tab moves between that tab's own views — week and month
    // here — and only changes tab once it runs out of them. Filmed here as the
    // separate movement it is, rather than mixed into tab changes.
    await swipeTab(page, 'left');
    await page.waitForTimeout(READ);
    await swipeTab(page, 'right');
    await page.waitForTimeout(READ);
  });

  test('04-de-xuat', async ({ page }) => {
    await arrive(page);
    await openTab(page, 'Đề xuất');
    await swipeTab(page, 'left');
    await page.waitForTimeout(READ);
    await swipeTab(page, 'right');
    await page.waitForTimeout(READ);
  });

  test('05-tao-de-xuat', async ({ page }) => {
    await arrive(page);
    await openTab(page, 'Đề xuất');
    await page.getByRole('button', { name: 'Tạo đề xuất mới' }).click();
    await expect(page.locator('[role="dialog"]')).toBeVisible();
    await page.waitForTimeout(READ * 2);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(BEAT);
  });

  test('06-lich', async ({ page }) => {
    await arrive(page);
    await openTab(page, 'Lịch');
    await page.waitForTimeout(READ * 2);
  });

  test('07-danh-ba', async ({ page }) => {
    await arrive(page);
    await openTab(page, 'Danh bạ');
    // The directory pages by branch, so the swipe here moves between centres.
    await swipeTab(page, 'left');
    await page.waitForTimeout(READ);
    await swipeTab(page, 'right');
    await page.waitForTimeout(READ);
  });

  test('08-thong-bao', async ({ page }) => {
    await arrive(page);
    await page.getByRole('button', { name: /Thông báo/ }).first().click();
    await page.waitForTimeout(READ * 2);
  });
});

test.describe('wall screen', () => {
  test.skip(({ isMobile }) => Boolean(isMobile), 'kiosk clip only');

  test('09-kiosk', async ({ page }) => {
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
});
