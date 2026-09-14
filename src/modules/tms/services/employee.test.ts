import { describe, expect, it } from 'vitest';
import type { ShiftConfig } from '@/shared/types';
import { attendanceRequestPayload, determineShift } from './employee';

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

  it('selects a later shift at its exact configured start time', () => {
    expect(determineShift('16:00', FIXTURE_SHIFTS).name).toBe('CHARLIE');
  });

  it('keeps an overnight shift available after midnight', () => {
    const overnightShifts: ShiftConfig[] = [
      { name: 'DAY', start: '08:00', end: '17:00', break_point: '17:30' },
      { name: 'NIGHT', start: '22:00', end: '02:00', break_point: '02:30' },
    ];
    expect(determineShift('01:15', overnightShifts).name).toBe('NIGHT');
  });

  it('sorts unordered input before resolving', () => {
    const shuffled = [FIXTURE_SHIFTS[2], FIXTURE_SHIFTS[0], FIXTURE_SHIFTS[1]] as ShiftConfig[];
    expect(determineShift('08:15', shuffled).name).toBe('ALPHA');
  });

  it('falls back to a default shift when none are configured', () => {
    expect(determineShift('10:00', []).name).toBeTruthy();
  });
});

describe('attendanceRequestPayload', () => {
  const clientRequestId = '40000000-0000-0000-0000-000000000001';

  it('keeps a reason-only explanation separate from a time correction', () => {
    expect(attendanceRequestPayload({ date: '2026-09-10', reason: 'Xe hỏng giữa đường', clientRequestId })).toEqual({
      request_type: 'EXPLANATION',
      from_date: '2026-09-10',
      to_date: '2026-09-10',
      reason: 'Xe hỏng giữa đường',
      client_request_id: clientRequestId,
    });
  });

  it('builds explicit timestamps for a missing attendance correction', () => {
    expect(attendanceRequestPayload({
      date: '2026-09-10',
      reason: 'Quên check-out',
      requestType: 'CORRECTION',
      requestedCheckin: '08:30',
      requestedCheckout: '17:35',
      clientRequestId,
    })).toMatchObject({
      request_type: 'CORRECTION',
      requested_checkin: '2026-09-10T08:30:00+07:00',
      requested_checkout: '2026-09-10T17:35:00+07:00',
    });
  });

  it('rolls an overnight checkout into the following calendar day', () => {
    expect(attendanceRequestPayload({
      date: '2026-09-10',
      reason: 'Ca đêm thiếu giờ ra',
      requestType: 'CORRECTION',
      requestedCheckin: '22:00',
      requestedCheckout: '02:00',
      clientRequestId,
    }).requested_checkout).toBe('2026-09-11T02:00:00+07:00');
  });

  it('rejects an incomplete correction before calling the backend', () => {
    expect(() => attendanceRequestPayload({
      date: '2026-09-10',
      reason: 'Quên check-out',
      requestType: 'CORRECTION',
      requestedCheckin: '08:30',
      clientRequestId,
    })).toThrow('Điều chỉnh công cần đủ giờ check-in và check-out hợp lệ.');
  });
});
