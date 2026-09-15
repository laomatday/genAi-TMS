import { beforeEach, describe, expect, it } from 'vitest';
import {
  canOpenKioskStation,
  forgetEffectiveCapabilities,
  hasControlCenterAccess,
  normalizeEffectiveCapabilities,
  rememberEffectiveCapabilities,
  takeCapabilityHandoff,
} from './workforceCapabilities';

describe('effective Workforce capabilities', () => {
  it('normalizes the bootstrap capability contract', () => {
    expect(normalizeEffectiveCapabilities({ capabilities: ['team.read', 'team.read', null, 2] }))
      .toEqual(['team.read']);
    expect(normalizeEffectiveCapabilities(null)).toEqual([]);
  });

  it('uses capabilities instead of role labels for Control Center reachability', () => {
    expect(hasControlCenterAccess(['schedule.manage'])).toBe(true);
    expect(hasControlCenterAccess(['attendance.self', 'request.submit'])).toBe(false);
  });

  it('keeps the dedicated Kiosk account exception explicit', () => {
    expect(canOpenKioskStation('Kiosk', [])).toBe(true);
    expect(canOpenKioskStation('Director', [])).toBe(false);
    expect(canOpenKioskStation('Manager', ['kiosk.manage'])).toBe(true);
  });
});

describe('capability handoff from sign-in', () => {
  const SUBJECT = 'org-1:EMP001';

  beforeEach(() => forgetEffectiveCapabilities());

  it('hands over the capabilities sign-in already fetched', () => {
    rememberEffectiveCapabilities(SUBJECT, { capabilities: ['team.read', 'settings.manage'] });
    expect(takeCapabilityHandoff(SUBJECT)).toEqual(['team.read', 'settings.manage']);
  });

  it('is single use, so a retry falls through to the server', () => {
    rememberEffectiveCapabilities(SUBJECT, { capabilities: ['team.read'] });
    expect(takeCapabilityHandoff(SUBJECT)).toEqual(['team.read']);
    expect(takeCapabilityHandoff(SUBJECT)).toBeNull();
  });

  it('never hands one account the capabilities of another', () => {
    rememberEffectiveCapabilities(SUBJECT, { capabilities: ['settings.manage'] });
    expect(takeCapabilityHandoff('org-1:EMP999')).toBeNull();
    // The mismatched entry is dropped rather than left in memory for later.
    expect(takeCapabilityHandoff(SUBJECT)).toBeNull();
  });

  it('refuses an empty subject rather than treating it as a match', () => {
    rememberEffectiveCapabilities(SUBJECT, { capabilities: ['settings.manage'] });
    expect(takeCapabilityHandoff('')).toBeNull();
  });

  it('is dropped on sign-out', () => {
    rememberEffectiveCapabilities(SUBJECT, { capabilities: ['settings.manage'] });
    forgetEffectiveCapabilities();
    expect(takeCapabilityHandoff(SUBJECT)).toBeNull();
  });

  it('stores nothing when there is no subject to key it on', () => {
    rememberEffectiveCapabilities('', { capabilities: ['settings.manage'] });
    expect(takeCapabilityHandoff(SUBJECT)).toBeNull();
  });
});
