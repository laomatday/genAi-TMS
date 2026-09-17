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
// getUserMedia has to succeed for the ordering below to mean anything: without
// a camera it fails instantly and the decoder is never reached, so the test
// would pass while proving nothing.
test.use({
  permissions: ['camera'],
  launchOptions: {
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  },
});

test('the QR decoder loads from this origin, after the camera opens', async ({ page }) => {
  await mockBackend(page);
  await page.addInitScript(() => {
    // What iOS Safari looks like to this code.
    delete (window as unknown as Record<string, unknown>).BarcodeDetector;
  });

  // Both events are recorded inside the page, in one array.
  //
  // Timing them from opposite sides did not work: getUserMedia was reported
  // through exposeFunction, which round-trips to the test process, while the
  // wasm fetch was seen by page.on('request') in that process directly. Two
  // clocks and an extra hop between them made the order flip under load — the
  // test passed alone and failed in a full run, which is worse than no test.
  await page.addInitScript(() => {
    const order: string[] = [];
    (window as unknown as { __order: string[] }).__order = order;

    const media = navigator.mediaDevices;
    const openCamera = media.getUserMedia.bind(media);
    media.getUserMedia = (constraints) => {
      order.push('camera');
      return openCamera(constraints);
    };

    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      // The dev server resolves the static `?url` import with its own request
      // at module-load time, long before anything decodes. That is a Vite
      // artifact — a production build inlines the path as a string — so only
      // the bare fetch, the one the decoder makes, is recorded.
      if (url.includes('.wasm') && !url.includes('?')) order.push(`wasm:${url}`);
      return originalFetch(input, init);
    };
  });

  await page.goto('/');
  await page.getByLabel('Tài khoản').fill('admin@example.com');
  await page.locator('#login-password').fill('correct-password');
  await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page.locator('#login-account')).toBeHidden({ timeout: 15_000 });

  await page.goto('/?tab=home&modal=qr');
  await expect(page.locator('[role="dialog"][aria-labelledby="qr-scanner-title"]').first())
    .toBeVisible({ timeout: 15_000 });

  const readOrder = () => page.evaluate(() => (window as unknown as { __order: string[] }).__order);
  await expect.poll(
    async () => (await readOrder()).some((entry) => entry.startsWith('wasm:')),
    { timeout: 20_000 },
  ).toBe(true);

  const order = await readOrder();

  // The camera must already be open by the time the decoder is fetched.
  //
  // Loading the decoder first is what broke iOS: Safari only honours
  // getUserMedia inside a short window after the tap, a megabyte of WebAssembly
  // spent it, and the camera was then refused without even a permission prompt.
  // Chromium does not enforce that window, so the order is asserted here rather
  // than left to be rediscovered on somebody's phone.
  expect(order.indexOf('camera'), `event order: ${order.join(' -> ')}`).toBeGreaterThanOrEqual(0);
  expect(
    order.indexOf('camera'),
    `getUserMedia must run before the decoder — event order: ${order.join(' -> ')}`,
  ).toBeLessThan(order.findIndex((entry) => entry.startsWith('wasm:')));

  // Resolved against the page before comparing: the decoder asks for a
  // root-relative path, which is same-origin but does not start with the origin
  // as a string.
  const origin = new URL(page.url()).origin;
  const offsite = order
    .filter((entry) => entry.startsWith('wasm:'))
    .map((entry) => new URL(entry.slice('wasm:'.length), origin))
    .filter((url) => url.origin !== origin)
    .map((url) => url.href);
  expect(offsite, 'the decoder must not be fetched from a third party').toEqual([]);
});
