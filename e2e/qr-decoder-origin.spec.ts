import { expect, test } from '@playwright/test';
import { mockBackend } from './support/backend';

/**
 * The scanner must decode without reaching the public internet.
 *
 * iOS Safari has no native BarcodeDetector, so every iPhone scan runs through a
 * WebAssembly build of ZXing — and zxing-wasm fetches that module from jsDelivr
 * unless told otherwise. On a phone that could not reach the CDN the camera came
 * up and nothing ever decoded, with the failure visible only in a console
 * warning. Android never showed it, because Chrome has the native detector and
 * never loads the polyfill at all.
 *
 * Chromium is in the same position as Android here, so the native detector is
 * removed before the page loads to force the path an iPhone actually takes.
 */
test('the QR decoder loads from this origin, not a public CDN', async ({ page }) => {
  await mockBackend(page);
  await page.addInitScript(() => {
    // What iOS Safari looks like to this code.
    delete (window as unknown as Record<string, unknown>).BarcodeDetector;
  });

  const wasmRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('.wasm')) wasmRequests.push(request.url());
  });

  await page.goto('/');
  await page.getByLabel('Tài khoản').fill('admin@example.com');
  await page.locator('#login-password').fill('correct-password');
  await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page.locator('#login-account')).toBeHidden({ timeout: 15_000 });

  await page.goto('/?tab=home&modal=qr');
  await expect(page.locator('[role="dialog"][aria-labelledby="qr-scanner-title"]').first())
    .toBeVisible({ timeout: 15_000 });

  await expect.poll(() => wasmRequests.length, { timeout: 20_000 }).toBeGreaterThan(0);

  const origin = new URL(page.url()).origin;
  const offsite = wasmRequests.filter((url) => !url.startsWith(origin));
  expect(offsite, 'the decoder must not be fetched from a third party').toEqual([]);
});
