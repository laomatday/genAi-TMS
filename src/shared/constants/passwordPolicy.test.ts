import { describe, expect, it } from 'vitest';
import { TMS_LIMITS } from './index';

describe('account password policy', () => {
  it('accepts passwords from eight characters', () => {
    expect(TMS_LIMITS.ACCOUNT_PASSWORD_MIN_LENGTH).toBe(8);
  });
});
