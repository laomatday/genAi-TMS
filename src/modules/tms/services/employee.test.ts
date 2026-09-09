import { describe, expect, it } from 'vitest';
import type { ShiftConfig } from '@/shared/types';
import { determineShift } from './employee';

// Synthetic fixtures only. In production `determineShift` is always called with
// `data.shifts`, which comes from Supabase (tms_dashboard_bundle_v1 → metadata.shifts).
// These arrays exist purely to exercise the sort / boundary algorithm.
const FIXTURE_SHIFTS: ShiftConfig[] = [
  { name: 'ALPHA', start: '07:00', end: '11:00', break_point: '11:30' },
  { name: 'BRAVO', start: '13:00', end: '16:00', break_point: '16:00' },
  { name: 'CHARLIE', start: '16:00', end: '19:00', break_point: '23:59' },
];

describe('determineShift', () => {
  it('returns the earliest shift before the working day starts', () => {
    expect(determineShift('05:00', FIXTURE_SHIFTS).name).toBe('ALPHA');
  });

  it('resolves a time inside the first shift window', () => {
    expect(determineShift('08:15', FIXTURE_SHIFTS).name).toBe('ALPHA');
  });

  it('rolls into the next shift once the previous boundary passes', () => {
    expect(determineShift('12:30', FIXTURE_SHIFTS).name).toBe('BRAVO');
  });

  it('returns the last shift late in the day', () => {
    expect(determineShift('18:30', FIXTURE_SHIFTS).name).toBe('CHARLIE');
  });

  it('sorts unordered input before resolving', () => {
    const shuffled = [FIXTURE_SHIFTS[2], FIXTURE_SHIFTS[0], FIXTURE_SHIFTS[1]] as ShiftConfig[];
    expect(determineShift('08:15', shuffled).name).toBe('ALPHA');
  });

  it('falls back to a default shift when none are configured', () => {
    expect(determineShift('10:00', []).name).toBeTruthy();
  });
});
