import { TMS_LIMITS } from '@/shared/constants';

/**
 * Spreads background refreshes across a time window and backs off after failures.
 * This prevents a fleet of clients opened around shift start from repeatedly
 * hitting the dashboard RPC at the same instant.
 */
export function nextDashboardRefreshDelay(
  consecutiveFailures: number,
  random: () => number = Math.random,
) {
  const failureCount = Number.isFinite(consecutiveFailures)
    ? Math.max(0, Math.floor(consecutiveFailures))
    : 0;
  const backoffDelay = Math.min(
    TMS_LIMITS.DASHBOARD_REFRESH_MAX_BACKOFF_MS,
    TMS_LIMITS.DASHBOARD_REFRESH_MS * (2 ** failureCount),
  );
  const jitter = backoffDelay * TMS_LIMITS.DASHBOARD_REFRESH_JITTER_RATIO;
  const randomValue = Math.min(1, Math.max(0, random()));

  return Math.round(Math.min(
    TMS_LIMITS.DASHBOARD_REFRESH_MAX_BACKOFF_MS,
    backoffDelay - jitter + (jitter * 2 * randomValue),
  ));
}
