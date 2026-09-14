import { describe, expect, it } from 'vitest';
import { TMS_LIMITS } from '@/shared/constants';
import { nextDashboardRefreshDelay } from './dashboardRefresh';

describe('nextDashboardRefreshDelay', () => {
  it('keeps a healthy client around the configured refresh interval', () => {
    expect(nextDashboardRefreshDelay(0, () => 0.5)).toBe(TMS_LIMITS.DASHBOARD_REFRESH_MS);
  });

  it('jitters clients across the configured refresh window', () => {
    const spread = TMS_LIMITS.DASHBOARD_REFRESH_MS * TMS_LIMITS.DASHBOARD_REFRESH_JITTER_RATIO;

    expect(nextDashboardRefreshDelay(0, () => 0)).toBe(TMS_LIMITS.DASHBOARD_REFRESH_MS - spread);
    expect(nextDashboardRefreshDelay(0, () => 1)).toBe(TMS_LIMITS.DASHBOARD_REFRESH_MS + spread);
  });

  it('backs off repeated failures without exceeding the operational ceiling', () => {
    expect(nextDashboardRefreshDelay(2, () => 0.5)).toBe(TMS_LIMITS.DASHBOARD_REFRESH_MS * 4);
    expect(nextDashboardRefreshDelay(100, () => 0.5)).toBe(TMS_LIMITS.DASHBOARD_REFRESH_MAX_BACKOFF_MS);
    expect(nextDashboardRefreshDelay(100, () => 1)).toBe(TMS_LIMITS.DASHBOARD_REFRESH_MAX_BACKOFF_MS);
  });

  it('normalizes invalid failure and random values', () => {
    expect(nextDashboardRefreshDelay(Number.NaN, () => -10)).toBe(
      TMS_LIMITS.DASHBOARD_REFRESH_MS * (1 - TMS_LIMITS.DASHBOARD_REFRESH_JITTER_RATIO),
    );
    expect(nextDashboardRefreshDelay(-3, () => 10)).toBe(
      TMS_LIMITS.DASHBOARD_REFRESH_MS * (1 + TMS_LIMITS.DASHBOARD_REFRESH_JITTER_RATIO),
    );
  });
});
