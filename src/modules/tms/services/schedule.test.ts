import { describe, expect, it } from 'vitest';
import { normalizeWorkforceSchedule } from './schedule';

describe('normalizeWorkforceSchedule', () => {
  it('keeps only valid server schedule rows', () => {
    expect(normalizeWorkforceSchedule({
      total: 2,
      rows: [
        {
          id: 'shift-1',
          work_date: '2026-09-15',
          shift_name: 'Ca hành chính',
          start_time: '08:30:00',
          end_time: '17:30:00',
          location_id: 'DN01',
          location_name: 'Đà Nẵng 1',
          note: 'Tầng 2',
        },
        { id: 'invalid', work_date: '15/09/2026' },
      ],
    })).toEqual({
      total: 2,
      items: [{
        id: 'shift-1',
        workDate: '2026-09-15',
        shiftName: 'Ca hành chính',
        startTime: '08:30:00',
        endTime: '17:30:00',
        locationId: 'DN01',
        locationName: 'Đà Nẵng 1',
        note: 'Tầng 2',
      }],
    });
  });

  it('returns an empty safe result for malformed payloads', () => {
    expect(normalizeWorkforceSchedule(null)).toEqual({ items: [], total: 0 });
  });
});
