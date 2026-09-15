import { isSupabaseConfigured, supabase } from '@/core/supabase';
import { isStaleBuildError } from '@/core/errors/staleBuild';

export type ClientMetricKind = 'FRONTEND' | 'LOAD';

const TELEMETRY_CODE_PATTERN = /^[A-Z0-9_]{2,48}$/;
const MAX_DURATION_MS = 120_000;
const reportedErrors = new WeakSet<object>();
let globalReportingInstalled = false;

export function normalizeTelemetryCode(value: string) {
  const normalized = value.trim().toUpperCase().replace(/[^A-Z0-9_]+/g, '_').slice(0, 48);
  return TELEMETRY_CODE_PATTERN.test(normalized) ? normalized : 'CLIENT_ERROR';
}
function normalizeDuration(value?: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(MAX_DURATION_MS, Math.max(0, Math.round(value || 0)));
}

export async function reportClientMetric(
  code: string,
  durationMs?: number,
  kind: ClientMetricKind = 'FRONTEND',
) {
  if (!isSupabaseConfigured || !navigator.onLine) return;

  try {
    await supabase.rpc('workforce_command', {
      p_action: 'telemetry.track',
      p_args: {
        kind,
        code: normalizeTelemetryCode(code),
        duration_ms: normalizeDuration(durationMs),
      },
    });
  } catch {
    // Telemetry must never interrupt attendance or recovery flows.
  }
}

export function reportClientError(code: string, error: unknown) {
  if (error && typeof error === 'object') {
    if (reportedErrors.has(error)) return;
    reportedErrors.add(error);
  }
  void reportClientMetric(code);
}

export function installGlobalErrorReporting() {
  if (globalReportingInstalled || typeof window === 'undefined') return;
  globalReportingInstalled = true;

  // Stale-build failures are reported under their own codes so they stop
  // drowning the real errors in the same bucket.
  window.addEventListener('error', (event) => {
    const error = event.error || event.message;
    reportClientError(isStaleBuildError(error) ? 'WINDOW_ERROR_STALE_BUILD' : 'WINDOW_ERROR', error);
  });
  window.addEventListener('unhandledrejection', (event) => {
    reportClientError(
      isStaleBuildError(event.reason) ? 'UNHANDLED_REJECTION_STALE_BUILD' : 'UNHANDLED_REJECTION',
      event.reason,
    );
  });
}
