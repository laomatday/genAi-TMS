import { describe, expect, it } from 'vitest';
import { TMS_LIMITS } from './index';

/**
 * The polling cadence is the single largest source of background load on a
 * database with no CPU headroom — two pollers run on it, so each open app costs
 * four queries per cycle. These assertions are here so a future change to the
 * numbers is a deliberate one.
 */
describe('background refresh budget', () => {
  it('costs no more than about 24 queries an hour per open app', () => {
    const cyclesPerHour = 3_600_000 / TMS_LIMITS.DASHBOARD_REFRESH_MS;
    const pollersOnThisInterval = 2; // the dashboard and the notification inbox
    const queriesPerDashboardCycle = 3; // bootstrap, history, requests
    const perHour = cyclesPerHour * (queriesPerDashboardCycle + pollersOnThisInterval - 1);
    expect(perHour).toBeLessThanOrEqual(30);
  });

  it('does not refetch on every glance at the phone', () => {
    expect(TMS_LIMITS.DASHBOARD_VISIBLE_STALE_MS).toBeGreaterThanOrEqual(60_000);
  });

  it('refreshes on return sooner than it polls, or returning would be pointless', () => {
    // Coming back to the app has to be able to produce fresher data than
    // waiting for the timer would.
    expect(TMS_LIMITS.DASHBOARD_VISIBLE_STALE_MS).toBeLessThan(TMS_LIMITS.DASHBOARD_REFRESH_MS);
  });

  it('keeps the QR window shorter than the code it refreshes', () => {
    // Unrelated to load, but the same file: a station must replace a code
    // before it expires, or the wall shows a dead one.
    expect(TMS_LIMITS.QR_REFRESH_MS / 1_000).toBeLessThan(TMS_LIMITS.QR_VALIDITY_SECONDS);
  });
});
