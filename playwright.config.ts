import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:3107',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'bun run dev:e2e',
    url: 'http://127.0.0.1:3107',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      VITE_SUPABASE_URL: 'https://e2e.supabase.invalid',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'e2e-publishable-key',
    },
  },
  projects: [
    {
      name: 'android-chromium',
      use: { ...devices['Pixel 5'] },
    },
    {
      name: 'ios-webkit',
      use: { ...devices['iPhone 13'] },
    },
    {
      name: 'desktop-chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
    {
      name: 'mobile-320-reflow',
      use: {
        browserName: 'chromium',
        viewport: { width: 320, height: 800 },
        screen: { width: 320, height: 800 },
        deviceScaleFactor: 1,
        hasTouch: true,
        isMobile: true,
      },
    },
  ],
});
