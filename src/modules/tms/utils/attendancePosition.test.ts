import { describe, expect, it } from 'vitest';
import { assertValidAttendancePosition } from './attendancePosition';

describe('attendance position contract', () => {
  it('does not impose a client accuracy threshold over tenant policy', () => {
    expect(() => assertValidAttendancePosition({ lat: 16.0544, lng: 108.2022, accuracy: 750 })).not.toThrow();
  });

  it('rejects malformed coordinates and accuracy', () => {
    expect(() => assertValidAttendancePosition({ lat: 91, lng: 108.2022, accuracy: 20 })).toThrow(/tọa độ/);
    expect(() => assertValidAttendancePosition({ lat: 16.0544, lng: 108.2022, accuracy: 0 })).toThrow(/độ chính xác/);
  });
});
