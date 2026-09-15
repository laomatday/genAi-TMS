import { describe, expect, it } from 'vitest';
import { TMS_LIMITS } from './index';

describe('account password policy', () => {
  it('accepts passwords from eight characters and keeps generated passwords stronger', () => {
    expect(TMS_LIMITS.ACCOUNT_PASSWORD_MIN_LENGTH).toBe(8);
    expect(TMS_LIMITS.TEMP_PASSWORD_LENGTH).toBeGreaterThanOrEqual(
      TMS_LIMITS.ACCOUNT_PASSWORD_MIN_LENGTH,
    );
  });
});
