import { expect, test, type Page } from '@playwright/test';
import { openEmployeeApp } from '../e2e/support/backend';

/**
 * Guards how many round trips opening the app costs.
 *
 * The database this runs against has no CPU headroom at the morning peak — a
 * query over a 43-row table measured 161ms, and checkpoints writing under a
 * megabyte took sixteen seconds — so every avoidable call is worth keeping
 * avoided. This runs against a production build on purpose: the dev server
 * runs React in StrictMode, which double-invokes effects and double-counts
 * every request one of them makes.
 */
async function recordCalls(page: Page) {
  const calls: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (!url.includes('e2e.supabase.invalid')) return;
    if (url.includes('/rpc/workforce_query')) {
      const body = request.postDataJSON() as { p_resource?: string } | null;
      calls.push(`query:${body?.p_resource ?? '?'}`);
      return;
    }
    if (url.includes('/functions/v1/trusted-device')) {
      const body = request.postDataJSON() as { action?: string } | null;
      calls.push(`device:${body?.action ?? '?'}`);
      return;
    }
    calls.push(url.split('e2e.supabase.invalid')[1] ?? url);
  });
  return calls;
}

test('opening the app stays inside its call budget', async ({ page }) => {
  const calls = await recordCalls(page);

  await openEmployeeApp(page);
  await expect(page.getByRole('navigation', { name: 'Điều hướng chính' })).toBeVisible();
  await page.waitForTimeout(2500);

  const cold = [...calls];
  // bootstrap exactly once: sign-in reads it to check the profile against the
  // authenticated user, and files it so the dashboard reads the same response
  // rather than asking again.
  expect(cold.filter((call) => call === 'query:bootstrap')).toHaveLength(1);
  // One request query, not one per scope — the team scope already returns the
  // reader's own rows.
  expect(cold.filter((call) => call === 'query:requests')).toHaveLength(1);
  expect(cold.filter((call) => call.startsWith('query:'))).toHaveLength(5);

  // Reopening is the common case: check in, close, come back.
  calls.length = 0;
  await page.reload();
  await expect(page.getByRole('navigation', { name: 'Điều hướng chính' })).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(2500);

  const warm = [...calls];
  // Reopening inside the staleness window paints the stored dashboard and does
  // not go to the network for it at all — the screen is already right, and the
  // database is the thing with nothing to spare at shift start.
  // Reference data the server marks as good for minutes is read from IndexedDB,
  // so a restart does not pay for it again. What is left is the data the
  // snapshot deliberately does not store — the directory and the team queue
  // stay network-only so a shared device keeps no colleague details — plus the
  // sign-in check.
  expect(warm, 'metadata should come from the persisted cache').not.toContain('query:metadata');
  expect(warm, 'directory rows are not in the snapshot, so they are fetched').toContain('query:directory');
  expect(warm.filter((call) => call.startsWith('query:'))).toHaveLength(4);
  expect(warm.length).toBeLessThan(cold.length);
});
