import { describe, expect, it } from 'vitest';
import { DEVICE_EXEMPT_ROLES } from './index';

describe('trusted-device role contract', () => {
  it('requires HR and Director accounts that can record attendance to verify a device', () => {
    expect(DEVICE_EXEMPT_ROLES).not.toContain('HR');
    expect(DEVICE_EXEMPT_ROLES).not.toContain('Director');
  });

  it('keeps only non-attendance operator roles exempt', () => {
    expect(DEVICE_EXEMPT_ROLES).toEqual(['Admin', 'Kiosk']);
  });
});
