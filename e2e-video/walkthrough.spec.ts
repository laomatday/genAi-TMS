import { expect, test, type Page } from '@playwright/test';
import { mockBackend } from '../e2e/support/backend';
import { swipeTab } from './support/gestures';

/**
 * One clip per screen, all inside a session already signed in by auth.setup.ts.
 *
 * Separate clips rather than one continuous take, because the edit happens
 * outside this repo: a single take makes whoever is cutting it find the
 * boundaries again, while separate takes hand the boundaries over already made,
 * numbered in running order. They are still one scenario — the sign-in happens
 * once, in clip 01, and nothing after it shows a login screen.
 *
 * Playwright names a video after its test, so the test titles below are the
 * delivered filenames.
 *
 * Every modal here is operated rather than merely opened. A still frame of an
 * empty form says the screen exists; filling it in says what it is for, and
 * that is the difference the scenario asked for.
 */

const BEAT = 700;
const READ = 1_700;

/**
 * Opens a screen by URL and waits for it to stop moving.
 *
 * The anchor is the absence of the login field, not the presence of the
 * navigation bar. A URL that opens straight into a modal leaves that bar either
 * inert behind the sheet or duplicated by the sheet's own, so waiting on it
 * failed on every modal clip. Absence of the sign-in screen is the thing
 * actually being relied on here anyway: it says the saved session carried over.
 */
async function open(page: Page, url: string) {
  await mockBackend(page);
  await page.goto(url);
  await expect(page.locator('#login-account')).toBeHidden({ timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(BEAT);
}

/**
 * Types into a field the way a thumb does, one character at a time.
 *
 * Cleared first, because some of these fields arrive with the system's own text
 * already in them and typing appended to it — the explanation reason came out
 * as one run-on sentence made of both.
 */
async function type(page: Page, selector: string, text: string) {
  const field = page.locator(selector);
  await field.click();
  await field.fill('');
  await page.waitForTimeout(300);
  await field.pressSequentially(text, { delay: 45 });
  await page.waitForTimeout(BEAT);
}

test('02-trang-chu', async ({ page }) => {
  await open(page, '/?tab=home');
  await page.waitForTimeout(READ * 2);
});

test('03-quet-qr', async ({ page, context }) => {
  // The fake camera holds a real code, so the scan completes and check-in runs
  // for real against the mock — and then failed on location, ending the clip on
  // "CHẤM CÔNG THẤT BẠI". The branch in the mock sits at 16.05/108.2 with a
  // 200 m radius, so the phone is placed on it and the scan succeeds.
  // accuracy matters as much as the coordinates: without it the app rejected the
  // fix outright — "Thiết bị không trả về độ chính xác GPS hợp lệ".
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 16.05, longitude: 108.2, accuracy: 12 });

  // By URL rather than the home button: with an open shift in the mock, that
  // button offers check-out instead of the scanner.
  //
  // But not from a cold load. Opening straight into ?modal=qr passed on its own
  // and failed inside a full run, which is the signature of a race: the shell
  // is still booting, and the scanner asks for a camera while it does. So the
  // app is brought up on a settled home screen first, and the modal is then
  // entered the way a tap would enter it — through history, without a reload.
  await open(page, '/?tab=home');
  await page.waitForTimeout(BEAT);
  await page.evaluate(() => {
    window.history.pushState({}, '', '/?tab=home&modal=qr');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });

  const scanner = page.locator('[role="dialog"][aria-labelledby="qr-scanner-title"]');
  await expect(scanner.first()).toBeVisible({ timeout: 15_000 });
  // A clip that starts before the first camera frame opens on a black stage.
  await expect.poll(
    () => page.evaluate(() => {
      const video = document.querySelector('.scanner-stage video') as HTMLVideoElement | null;
      return video ? video.readyState >= 2 && video.videoWidth > 0 : false;
    }),
    { timeout: 15_000 },
  ).toBe(true);
  // Long enough to cover the scan landing and the result that follows it.
  await page.waitForTimeout(READ * 4);
});

test('04-ket-thuc-ca', async ({ page }) => {
  await open(page, '/?tab=home&modal=checkout');
  // A confirm is an alertdialog, not a dialog.
  await expect(page.locator('[role="alertdialog"]').first()).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(READ * 2);
});

test('05-cham-cong', async ({ page }) => {
  await open(page, '/?tab=history');
  await page.waitForTimeout(READ);
  // A swipe inside a tab moves between that tab's own views — week and month
  // here — and only changes tab once it runs out of them.
  await swipeTab(page, 'left');
  await page.waitForTimeout(READ);
  await swipeTab(page, 'right');
  await page.waitForTimeout(READ);
});

test('06-giai-trinh', async ({ page }) => {
  // No date in the URL. Naming one meant guessing, and the guess landed on a
  // day that already had a request filed: the clip ended on a duplicate error
  // with the date field empty. The days that can actually be explained are the
  // ones the dropdown lists, so the first of those is taken from the list.
  await open(page, '/?tab=history&modal=explanation');
  await expect(page.locator('[role="dialog"]').first()).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(READ);

  await page.locator('button[aria-controls="explain-date-options"]').click();
  await page.waitForTimeout(BEAT);
  const day = page.locator('#explain-date-options [role="option"]').first();
  await expect(day).toBeVisible({ timeout: 10_000 });
  await day.click();
  await page.waitForTimeout(BEAT);

  // Choose how the missing time is resolved, when the day has any missing.
  // Scoped to the segmented control, and named exactly.
  //
  // `getByRole('button', { name: 'Bổ sung giờ' })` matches on a substring, so it
  // also caught the banner headed "Bổ sung giờ chấm công". Two matches makes
  // isVisible() throw, a `.catch(() => false)` turned that into "no such
  // control", and the whole block that fills the hours was skipped silently on
  // every take — which is why the clip kept ending on "thiếu thông tin" no
  // matter what was changed inside a block that never ran.
  const resolution = page.getByRole('group', { name: 'Cách xử lý dữ liệu thiếu' });
  const hasTimes = await resolution.isVisible();
  if (hasTimes) {
    await resolution.getByRole('button', { name: 'Bổ sung giờ', exact: true }).click();
    await page.waitForTimeout(BEAT);
  }

  await type(page, '#explain-reason-textarea', 'Xe hỏng dọc đường, đã báo quản lý qua Zalo lúc 07:50.');

  // The hours go in last, immediately before sending.
  //
  // Filled earlier they kept coming back empty while the reason typed after
  // them survived, so nothing was remounting — something re-seeds these two
  // fields from the selected day when the dashboard refreshes in the
  // background, and a long clip always outlived one of those refreshes. Filling
  // them at the end closes that window instead of racing it.
  //
  // Filled, not clicked first: clicking opens the native time picker, which
  // swallows whatever is typed after it.
  if (hasTimes) {
    const times = page.locator('[role="dialog"] input[type="time"]');
    await expect(times.first()).toBeVisible({ timeout: 10_000 });
    await times.first().fill('08:15');
    await page.waitForTimeout(500);
    await times.nth(1).fill('17:30');
    await page.waitForTimeout(BEAT);
    // The clip is worthless if these silently failed, which is exactly what
    // happened before, so it is asserted rather than hoped for.
    await expect(times.first()).toHaveValue('08:15');
    await expect(times.nth(1)).toHaveValue('17:30');
  }

  // Sending opens the confirm step, which is a screen of its own and belongs in
  // the clip: it is the last thing between the person and a filed request.
  const send = page.getByRole('button', { name: /Gửi (giải trình|bổ sung giờ)/ });
  if (await send.isEnabled().catch(() => false)) {
    await send.click();
    await page.waitForTimeout(READ * 2);
  } else {
    await page.waitForTimeout(READ);
  }
});

test('07-de-xuat', async ({ page }) => {
  await open(page, '/?tab=requests');
  await page.waitForTimeout(READ);
  await swipeTab(page, 'left');
  await page.waitForTimeout(READ);
  await swipeTab(page, 'right');
  await page.waitForTimeout(READ);
});

test('08-tao-de-xuat', async ({ page }) => {
  await open(page, '/?tab=requests');
  await page.getByRole('button', { name: 'Tạo đề xuất mới' }).click();
  await expect(page.locator('[role="dialog"]').first()).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(READ);

  // The type control is a trigger that opens its own list, not a native select.
  await page.locator('#request-type-trigger').click();
  await page.waitForTimeout(BEAT);
  const option = page.getByRole('option').first();
  if (await option.isVisible().catch(() => false)) {
    await option.click();
  } else {
    await page.keyboard.press('Escape');
  }
  await page.waitForTimeout(BEAT);

  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  await page.locator('#request-from-date').fill(tomorrow);
  await page.waitForTimeout(400);
  await page.locator('#request-to-date').fill(tomorrow);
  await page.waitForTimeout(BEAT);

  await type(page, '#request-reason', 'Đưa con đi khám định kỳ, đã sắp xếp người trực thay.');
  await page.waitForTimeout(READ);
});

test('09-lich', async ({ page }) => {
  await open(page, '/?tab=calendar');
  await page.waitForTimeout(READ * 2);
});

test('10-danh-ba', async ({ page }) => {
  await open(page, '/?tab=contacts');
  await page.waitForTimeout(READ);
  // The directory pages by branch, so a swipe here moves between centres.
  await swipeTab(page, 'left');
  await page.waitForTimeout(READ);
  await swipeTab(page, 'right');
  await page.waitForTimeout(READ);
});

test('11-chi-tiet-lien-he', async ({ page }) => {
  await open(page, '/?tab=contacts');
  const contact = page.getByText('Trần Minh Khoa').first();
  await expect(contact).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(BEAT);
  await contact.click();
  await expect(page.locator('[role="dialog"]').first()).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(READ * 2);
});

test('12-thong-bao', async ({ page }) => {
  await open(page, '/?tab=home');
  await page.getByRole('button', { name: /Thông báo/ }).first().click();
  await page.waitForTimeout(READ * 2);
});

test('13-ho-so', async ({ page }) => {
  await open(page, '/?tab=profile');
  await page.waitForTimeout(READ * 2);
});

test('14-doi-mat-khau', async ({ page }) => {
  await open(page, '/?tab=profile&modal=profile-password');
  await expect(page.locator('[role="dialog"]').first()).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(READ);
  const fields = page.locator('[role="dialog"] input[type="password"]');
  const count = await fields.count();
  for (let index = 0; index < Math.min(count, 3); index += 1) {
    await fields.nth(index).click();
    await fields.nth(index).pressSequentially('aaaaaaaa', { delay: 55 });
    await page.waitForTimeout(400);
  }
  await page.waitForTimeout(READ);
});

test('15-cai-dat', async ({ page }) => {
  await open(page, '/?tab=home');
  // Settings opens through the header menu, not its URL: deep linking to
  // ?modal=settings closes itself, because the sheet reports "closed" on mount.
  const actions = page.getByRole('button', { name: 'Mở menu tác vụ' });
  await expect(actions).toBeVisible({ timeout: 15_000 });
  await actions.click();
  await page.waitForTimeout(BEAT);
  await page.getByRole('menuitem', { name: 'Cài đặt' }).click();
  await expect(page.getByRole('dialog', { name: 'Cài đặt' })).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(READ * 2);
});

test('16-huong-dan', async ({ page }) => {
  await open(page, '/?tab=home&modal=settings-guide');
  // Settings sits underneath, so there are two dialogs; this names the top one.
  await expect(page.getByRole('dialog', { name: /Chấm công|Hướng dẫn/ }).first())
    .toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(READ * 2);
});
