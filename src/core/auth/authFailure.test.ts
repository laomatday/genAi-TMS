import { describe, expect, it } from 'vitest';
import { AuthRetryableFetchError } from '@supabase/supabase-js';
import { createAuthOperationGuard, isRetryableAuthFailure, withAuthDeadline } from './authFailure';

describe('isRetryableAuthFailure', () => {
  it('recognizes Supabase retryable transport failures', () => {
    expect(isRetryableAuthFailure(new AuthRetryableFetchError('HTTP 504', 504))).toBe(true);
  });

  it('recognizes generic gateway and network failures', () => {
    expect(isRetryableAuthFailure({ status: 503, message: 'Unavailable' })).toBe(true);
    expect(isRetryableAuthFailure(new TypeError('Failed to fetch'))).toBe(true);
  });

  it('does not hide invalid credentials or domain errors as outages', () => {
    expect(isRetryableAuthFailure({ status: 400, message: 'Invalid login credentials' })).toBe(false);
    expect(isRetryableAuthFailure({ code: 'PGRST202', message: 'Unknown query resource' })).toBe(false);
  });

  it('keeps the session when the database is merely overloaded', () => {
    // Exactly what PostgREST returns for the profile read under peak load: a
    // SQLSTATE, no HTTP status, and a message with no recognizable code in it.
    expect(isRetryableAuthFailure({
      code: '57014',
      message: 'canceling statement due to statement timeout',
    })).toBe(true);
    expect(isRetryableAuthFailure({ code: '53300', message: 'too many connections' })).toBe(true);
    expect(isRetryableAuthFailure({ code: '40P01', message: 'deadlock detected' })).toBe(true);
  });

  it('still signs out when the database answers about who the caller is', () => {
    // Signing out is the correct response to these, and must not be swallowed
    // by the rule above.
    expect(isRetryableAuthFailure({ code: '28000', message: 'Vui lòng đăng nhập.' })).toBe(false);
    expect(isRetryableAuthFailure({ code: '42501', message: 'Tài khoản không hoạt động.' })).toBe(false);
  });

  it('bounds an authentication call that never settles', async () => {
    const pending = new Promise<never>(() => undefined);
    await expect(withAuthDeadline(pending, 1)).rejects.toMatchObject({
      name: 'AuthOperationTimeoutError',
      status: 504,
    });
  });
});

describe('createAuthOperationGuard', () => {
  it('prevents an older restore from committing after a newer restore starts', () => {
    const guard = createAuthOperationGuard();
    const firstRestoreIsCurrent = guard.begin();
    const secondRestoreIsCurrent = guard.begin();

    expect(firstRestoreIsCurrent()).toBe(false);
    expect(secondRestoreIsCurrent()).toBe(true);
  });

  it('invalidates an in-flight restore when the session signs out', () => {
    const guard = createAuthOperationGuard();
    const restoreIsCurrent = guard.begin();

    guard.invalidate();

    expect(restoreIsCurrent()).toBe(false);
  });
});
