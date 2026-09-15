import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DEVICE_LOCK_ROLES,
  DEVICE_EXEMPT_ROLES,
  DEVICE_LOCK_EDITABLE_ROLES,
  normalizeDeviceLockRoles,
  requiresDeviceLock,
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
    for (const role of ['Staff', 'Leader', 'Manager', 'Director', 'HR'] as const) {
      expect(requiresDeviceLock(role, DEFAULT_DEVICE_LOCK_ROLES)).toBe(true);
    }
  });

  // An administrator needs a way back in when a device is lost or a binding has
  // to be cleared, so the default leaves Admin unlocked.
  it('leaves Admin unlocked by default but allows locking it', () => {
    expect(requiresDeviceLock('Admin', DEFAULT_DEVICE_LOCK_ROLES)).toBe(false);
    expect(DEVICE_LOCK_EDITABLE_ROLES).toContain('Admin');
    expect(requiresDeviceLock('Admin', ['Admin'])).toBe(true);
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
