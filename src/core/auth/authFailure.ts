import { isAuthRetryableFetchError } from '@supabase/supabase-js';

export const AUTH_RESTORE_UNAVAILABLE_MESSAGE =
  'Dịch vụ xác thực đang tạm gián đoạn. Phiên đăng nhập trên thiết bị chưa bị xóa; vui lòng thử lại sau ít phút.';

export const AUTH_LOGIN_UNAVAILABLE_MESSAGE =
  'Dịch vụ đăng nhập đang tạm gián đoạn. Vui lòng thử lại sau ít phút.';

const AUTH_OPERATION_TIMEOUT_MS = 12_000;

class AuthOperationTimeoutError extends Error {
  readonly status = 504;

  constructor() {
    super('Authentication request timed out');
    this.name = 'AuthOperationTimeoutError';
  }
}

export function createAuthOperationGuard() {
  let revision = 0;
  return {
    begin() {
      const operation = ++revision;
      return () => revision === operation;
    },
    invalidate() {
      revision += 1;
    },
  };
}

export function withAuthDeadline<T>(
  operation: Promise<T>,
  timeoutMs = AUTH_OPERATION_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new AuthOperationTimeoutError()), timeoutMs);
    operation.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

/**
 * Postgres states that mean "ask again later", not "you are not who you say".
 *
 * The profile read that restores a session goes straight to `workforce_query`,
 * so a database under load answers it with a PostgREST error carrying a
 * SQLSTATE and no HTTP status. Nothing below recognised those, so a momentary
 * timeout was classified as a dead session and the device was signed out —
 * which is the worst possible response, because every sign-out returns as a
 * fresh password login costing 74 ms of bcrypt on a database that already had
 * no CPU left. That is the loop that turned a slow morning into 122 password
 * logins against 5 token refreshes.
 *
 * Deliberately absent: 28000 (not authenticated) and 42501 (inactive account).
 * Those are real answers about who the caller is, and signing out is correct.
 */
const TRANSIENT_POSTGRES_STATES: ReadonlySet<string> = new Set([
  '57014', // statement timeout — the one actually seen during the peak
  '57P03', // cannot connect now, database starting up
  '53300', // too many connections
  '53400', // configuration limit exceeded
  '55P03', // lock not available
  '40001', // serialization failure
  '40P01', // deadlock detected
  '08000', '08003', '08006', // connection exception, broken, failure
]);

export function isRetryableAuthFailure(error: unknown): boolean {
  if (isAuthRetryableFetchError(error)) return true;

  const candidate = error && typeof error === 'object'
    ? error as { status?: unknown; message?: unknown; code?: unknown }
    : null;

  if (typeof candidate?.code === 'string' && TRANSIENT_POSTGRES_STATES.has(candidate.code)) {
    return true;
  }
  const status = Number(candidate?.status);
  if (Number.isFinite(status) && (status === 0 || status === 408 || status === 429 || status >= 500)) {
    return true;
  }

  const message = error instanceof Error
    ? error.message
    : typeof candidate?.message === 'string'
      ? candidate.message
      : String(error ?? '');

  return /(?:failed to fetch|network(?:error)?|load failed|http\s*(?:408|429|5\d\d)|\b(?:408|429|5\d\d)\b)/i.test(message);
}
