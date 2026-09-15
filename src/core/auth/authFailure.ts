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

export function isRetryableAuthFailure(error: unknown): boolean {
  if (isAuthRetryableFetchError(error)) return true;

  const candidate = error && typeof error === 'object'
    ? error as { status?: unknown; message?: unknown }
    : null;
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
