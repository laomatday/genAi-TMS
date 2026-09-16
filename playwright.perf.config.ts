import { defineConfig, devices } from '@playwright/test';

/**
 * Measures the real call budget against a production build.
 *
 * The dev server runs React in StrictMode, which double-invokes effects and so
 * double-counts every request an effect makes — the opposite of what this needs
 * to measure.
 *
 * Run it with `bun run perf`, which builds against the fake Supabase origin the
 * mock answers on. A dist built for the real project points the app at the real
 * database, and the mock's routes never match.
 */
export default defineConfig({
  testDir: './e2e-perf',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: { ...devices['Pixel 5'], baseURL: 'http://127.0.0.1:3108' },
  webServer: {
    command: 'vite preview --host 127.0.0.1 --port 3108 --strictPort',
    url: 'http://127.0.0.1:3108',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
