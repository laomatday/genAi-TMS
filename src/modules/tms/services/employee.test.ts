import { describe, expect, it } from 'vitest';
import type { ShiftConfig } from '@/shared/types';
import { determineShift } from './employee';

const SHIFTS: ShiftConfig[] = [
  { name: 'Ca Sáng', start: '08:30', end: '12:00', break_point: '13:00' },
  { name: 'Ca Chiều', start: '14:00', end: '17:30', break_point: '17:30' },
  { name: 'Ca Tối', start: '17:30', end: '21:00', break_point: '23:59' },
];

describe('determineShift', () => {
  it('returns the earliest shift before the working day starts', () => {
    expect(determineShift('06:00', SHIFTS).name).toBe('Ca Sáng');
  });

  it('resolves a time inside the morning shift window', () => {
    expect(determineShift('09:15', SHIFTS).name).toBe('Ca Sáng');
  });

  it('rolls into the afternoon shift once the morning boundary passes', () => {
    expect(determineShift('13:30', SHIFTS).name).toBe('Ca Chiều');
  });

  it('returns the last shift late at night', () => {
    expect(determineShift('20:30', SHIFTS).name).toBe('Ca Tối');
  });

  it('falls back to a default shift when none are configured', () => {
    expect(determineShift('10:00', []).name).toBeTruthy();
  });
});
