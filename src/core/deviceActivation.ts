/**
 * Whether this account already has a trusted device bound on this browser.
 *
 * `unknown` until the trusted-device status call comes back. The password
 * reminder waits for that rather than guessing, because showing the prompt on
 * top of the activation screen would ask someone to change a password before
 * they can reach the app at all.
 */
export type DeviceActivationState = 'unknown' | 'activated' | 'unbound';

let current: DeviceActivationState = 'unknown';
const listeners = new Set<() => void>();

export function getDeviceActivation(): DeviceActivationState {
  return current;
}

export function setDeviceActivation(next: DeviceActivationState) {
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener();
}

export function subscribeDeviceActivation(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Maps a trusted-device status response onto the two states the UI cares about. */
export function activationFromStatus(result: unknown): DeviceActivationState {
  if (!result || typeof result !== 'object') return 'unknown';
  const { ok, state } = result as { ok?: unknown; state?: unknown };
  // A blocked account never reaches the app, so nothing should be layered over
  // the gate telling it why.
  if (ok !== true || state === 'BLOCKED') return 'unknown';
  if (state === 'VERIFIED' || state === 'ACTIVE') return 'activated';
  if (state === 'NEEDS_ACTIVATION' || state === 'EXEMPT') return 'unbound';
  return 'unknown';
}

/** Resets the module between tests and after a sign-out. */
export function resetDeviceActivation() {
  current = 'unknown';
}
