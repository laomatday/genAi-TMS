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
 * Playwright records at device pixels, not CSS pixels — measured, not assumed:
 * a 432x936 viewport at deviceScaleFactor 3 produces a 1296x2808 file. So the
 * same trick the screenshots use works here, and the phone keeps a phone's
 * layout while the recording comes out at a phone's real resolution.
 *
 *   mobile   432 x 936  @2.5  ->  1080 x 2340   (a current phone, exactly)
 *   kiosk   1080 x 1920 @1    ->  1080 x 1920   (the wall screen, on its side)
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
        deviceScaleFactor: 2.5,
        isMobile: true,
        hasTouch: true,
        video: { mode: 'on', size: { width: 1080, height: 2340 } },
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
