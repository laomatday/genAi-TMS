import { defineConfig } from '@playwright/test';

/**
 * Screenshot capture, kept in its own config and directory so `bun run test:e2e`
 * never produces images as a side effect and this never joins the test gate.
 *
 * Both projects render at a CSS size the app is actually designed for and then
 * raise deviceScaleFactor, which is what makes the output high resolution: the
 * layout stays a phone or a desktop, while every pixel is drawn several times
 * over. Scaling the viewport instead would hand the app a screen size no device
 * has and change which layout it chooses.
 *
 *   mobile   432 x 936  @5  ->  2160 x 4680
 *   desktop 1920 x 1080 @2  ->  3840 x 2160  (UHD 4K exactly)
 */
export default defineConfig({
  testDir: './e2e-screens',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  timeout: 120_000,
  use: {
    baseURL: 'http://127.0.0.1:3107',
    browserName: 'chromium',
    locale: 'vi-VN',
    timezoneId: 'Asia/Ho_Chi_Minh',
    colorScheme: 'light',
    // Screens are captured at rest: no entry animation half-played, no spinner
    // caught mid-turn.
    reducedMotion: 'reduce',
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
        deviceScaleFactor: 5,
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: 'desktop',
      use: {
        viewport: { width: 1920, height: 1080 },
        screen: { width: 1920, height: 1080 },
        deviceScaleFactor: 2,
      },
    },
  ],
});
