import { describe, expect, it } from 'vitest';
import { DEVICE_EXEMPT_ROLES } from './index';

describe('trusted-device role contract', () => {
  it('requires every interactive employee account to verify a device', () => {
    expect(DEVICE_EXEMPT_ROLES).not.toContain('HR');
    expect(DEVICE_EXEMPT_ROLES).not.toContain('Director');
    expect(DEVICE_EXEMPT_ROLES).not.toContain('Admin');
  });

  it('keeps only the dedicated kiosk operator exempt', () => {
    expect(DEVICE_EXEMPT_ROLES).toEqual(['Kiosk']);
  });
});
