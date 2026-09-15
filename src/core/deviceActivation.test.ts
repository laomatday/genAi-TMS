import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  activationFromStatus,
  getDeviceActivation,
  resetDeviceActivation,
  setDeviceActivation,
  subscribeDeviceActivation,
} from './deviceActivation';

beforeEach(() => resetDeviceActivation());

describe('activationFromStatus', () => {
  it('treats a bound device as activated whether or not a grant is live', () => {
    expect(activationFromStatus({ ok: true, state: 'VERIFIED' })).toBe('activated');
    expect(activationFromStatus({ ok: true, state: 'ACTIVE' })).toBe('activated');
  });

  it('treats an account with no device as unbound', () => {
    expect(activationFromStatus({ ok: true, state: 'NEEDS_ACTIVATION' })).toBe('unbound');
    // Roles exempt from the device lock never bind one, so they are unbound too.
    expect(activationFromStatus({ ok: true, state: 'EXEMPT' })).toBe('unbound');
  });

  it('stays unknown for a blocked or unreadable response', () => {
    // A blocked account is held at the device gate, so nothing may cover it.
    expect(activationFromStatus({ ok: false, state: 'BLOCKED' })).toBe('unknown');
    expect(activationFromStatus(null)).toBe('unknown');
    expect(activationFromStatus('BLOCKED')).toBe('unknown');
  });
});

describe('the activation store', () => {
  it('notifies subscribers only when the state actually changes', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeDeviceActivation(listener);
    setDeviceActivation('activated');
    setDeviceActivation('activated');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getDeviceActivation()).toBe('activated');
    unsubscribe();
    setDeviceActivation('unbound');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
