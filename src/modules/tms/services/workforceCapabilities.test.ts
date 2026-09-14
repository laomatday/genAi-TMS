import { describe, expect, it } from 'vitest';
import {
  canOpenKioskStation,
  hasControlCenterAccess,
  normalizeEffectiveCapabilities,
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
