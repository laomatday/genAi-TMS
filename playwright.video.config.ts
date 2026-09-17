import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Same fake camera the screenshot run builds, for the same reason: the scanner
// opens a real getUserMedia stream and would otherwise be filmed in its
// permission-denied state. Built by `bun run screens`; absent is survivable.
const FAKE_CAMERA = resolve('.cache/fake-camera.y4m');
const cameraArgs = [
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  ...(existsSync(FAKE_CAMERA) ? [`--use-file-for-fake-video-capture=${FAKE_CAMERA}`] : []),
];

/**
 * Screen recording, separate from both the test gate and the screenshot run.
 *
 * `size` must equal the viewport, and deviceScaleFactor does nothing here.
 *
 * The screenshots get their resolution from deviceScaleFactor, and the first
 * version of this config assumed video worked the same way: viewport 432x936 at
 * scale 2.5, size 1080x2340. The file came out 1080x2340 and that was taken as
 * proof. It was not. Playwright only ever scales a recording *down* to fit the
 * size asked for, so the page was drawn at its 432x936 CSS size into the corner
 * of a 1080x2340 canvas and the remaining two thirds were filled with grey.
 *
 * So video caps out at the CSS viewport, and the frame is only full when size
 * matches it. Enlarging the viewport instead is not a way out: the phone layout
 * ends at 768px, and the recordings have to keep the same geometry as the
 * screenshots so the two can be cut together. The upscale to a deliverable size
 * happens in ffmpeg afterwards, where it is visible as an upscale.
 *
 *   mobile   432 x 936   (upscaled to 1080 x 2340 on the way out)
 *   kiosk   1080 x 1920  (already full size; the wall screen on its side)
 *
 * Unlike the screenshots, motion is left on. A still is better without a
 * half-played transition; a recording is mostly transitions, and reducedMotion
 * would film an app that appears to teleport between screens.
 */
export default defineConfig({
  testDir: './e2e-video',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  timeout: 300_000,
  outputDir: '.cache/video-raw',
  use: {
    baseURL: 'http://127.0.0.1:3107',
    browserName: 'chromium',
    permissions: ['camera'],
    launchOptions: { args: cameraArgs },
    locale: 'vi-VN',
    timezoneId: 'Asia/Ho_Chi_Minh',
    colorScheme: 'light',
  },
  webServer: {
    command: 'bun run dev:e2e',
    url: 'http://127.0.0.1:3107',
    reuseExistingServer: true,
    timeout: 120_000,
    env: {
      VITE_SUPABASE_URL: 'https://e2e.supabase.invalid',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'e2e-publishable-key',
    },
  },
  projects: [
    {
      name: 'mobile',
      use: {
        viewport: { width: 432, height: 936 },
        screen: { width: 432, height: 936 },
        isMobile: true,
        hasTouch: true,
        video: { mode: 'on', size: { width: 432, height: 936 } },
      },
    },
    {
      name: 'kiosk',
      use: {
        viewport: { width: 1080, height: 1920 },
        screen: { width: 1080, height: 1920 },
        deviceScaleFactor: 1,
        video: { mode: 'on', size: { width: 1080, height: 1920 } },
      },
    },
  ],
});
