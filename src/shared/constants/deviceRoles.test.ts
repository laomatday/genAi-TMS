import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DEVICE_LOCK_ROLES,
  DEVICE_EXEMPT_ROLES,
  DEVICE_LOCK_EDITABLE_ROLES,
  normalizeDeviceLockRoles,
  requiresDeviceLock,
  resolveDeviceLock,
} from './index';

describe('trusted-device role contract', () => {
  // The client may only skip the round trip where the server could add nothing.
  it('keeps only the dedicated kiosk operator out of the server check', () => {
    expect(DEVICE_EXEMPT_ROLES).toEqual(['Kiosk']);
  });

  it('never short-circuits the gate for a role an admin can unlock', () => {
    for (const role of DEVICE_LOCK_EDITABLE_ROLES) {
      expect(DEVICE_EXEMPT_ROLES).not.toContain(role);
    }
  });
});

describe('device lock policy', () => {
  it('locks every everyday role by default', () => {
    for (const role of ['Staff', 'Leader', 'Manager', 'Director'] as const) {
      expect(requiresDeviceLock(role, DEFAULT_DEVICE_LOCK_ROLES)).toBe(true);
    }
  });

  // Both administer from a desk rather than attending from one phone, and one of
  // them has to stay reachable to clear a lost device.
  it('leaves Admin and HR unlocked by default', () => {
    expect(requiresDeviceLock('Admin', DEFAULT_DEVICE_LOCK_ROLES)).toBe(false);
    expect(requiresDeviceLock('HR', DEFAULT_DEVICE_LOCK_ROLES)).toBe(false);
  });

  it('still allows an admin to lock those roles deliberately', () => {
    expect(DEVICE_LOCK_EDITABLE_ROLES).toContain('Admin');
    expect(DEVICE_LOCK_EDITABLE_ROLES).toContain('HR');
    expect(requiresDeviceLock('Admin', ['Admin'])).toBe(true);
    expect(requiresDeviceLock('HR', ['HR'])).toBe(true);
  });

  it('never locks a kiosk station, even when configured to', () => {
    expect(requiresDeviceLock('Kiosk', ['Kiosk' as never, 'Staff'])).toBe(false);
    expect(normalizeDeviceLockRoles(['Kiosk', 'Staff'])).toEqual(['Staff']);
  });

  it('reads a stored JSON array and drops unknown roles', () => {
    expect(normalizeDeviceLockRoles('["Staff","Manager"]')).toEqual(['Staff', 'Manager']);
    expect(normalizeDeviceLockRoles(['Staff', 'Wizard', 'Staff'])).toEqual(['Staff']);
  });

  // A broken setting must not silently switch device binding off for everyone.
  it('falls back to the default when the value cannot be read', () => {
    expect(normalizeDeviceLockRoles(null)).toEqual([...DEFAULT_DEVICE_LOCK_ROLES]);
    expect(normalizeDeviceLockRoles('not json')).toEqual([...DEFAULT_DEVICE_LOCK_ROLES]);
    expect(normalizeDeviceLockRoles('{"leave":[]}')).toEqual([...DEFAULT_DEVICE_LOCK_ROLES]);
  });

  // An explicitly empty list is a deliberate choice and is honoured.
  it('honours an explicit empty list', () => {
    expect(normalizeDeviceLockRoles('[]')).toEqual([]);
  });
});

describe('per-employee device lock override', () => {
  it('follows the role policy when the employee has no override', () => {
    expect(resolveDeviceLock({ role: 'Staff', override: null })).toBe(true);
    expect(resolveDeviceLock({ role: 'Admin', override: null })).toBe(false);
    // An omitted field must read the same as an explicit null.
    expect(resolveDeviceLock({ role: 'Staff' })).toBe(true);
  });

  it('lets an explicit value win over the role policy in both directions', () => {
    expect(resolveDeviceLock({ role: 'Staff', override: false })).toBe(false);
    expect(resolveDeviceLock({ role: 'Admin', override: true })).toBe(true);
  });

  // Shared hardware has no individual owner to bind, so this is not a policy
  // choice that an override gets to make.
  it('never locks a kiosk station, even when overridden to true', () => {
    expect(resolveDeviceLock({ role: 'Kiosk', override: true })).toBe(false);
  });

  it('resolves against the tenant policy it is given, not the default', () => {
    expect(resolveDeviceLock({ role: 'Admin', override: null, lockedRoles: ['Admin'] })).toBe(true);
    expect(resolveDeviceLock({ role: 'Staff', override: null, lockedRoles: [] })).toBe(false);
  });
});
