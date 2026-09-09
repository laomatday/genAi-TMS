import { afterEach, describe, expect, it } from 'vitest';
import {
  calculateDistance,
  formatDateString,
  getFeedbackPrefs,
  getShortName,
  setFeedbackPrefs,
  timeToMinutes,
  toISODateString,
} from './helpers';

describe('getShortName', () => {
  it('returns the last word of a full name', () => {
    expect(getShortName('Nguyễn Văn An')).toBe('An');
  });

  it('handles empty input', () => {
    expect(getShortName('')).toBe('');
  });
});

describe('timeToMinutes', () => {
  it('converts HH:mm to minutes past midnight', () => {
    expect(timeToMinutes('08:30')).toBe(510);
    expect(timeToMinutes('00:00')).toBe(0);
    expect(timeToMinutes('23:59')).toBe(1439);
  });

  it('returns 0 for malformed input', () => {
    expect(timeToMinutes('')).toBe(0);
    expect(timeToMinutes('abc')).toBe(0);
  });
});

describe('calculateDistance', () => {
  it('is ~0 for identical coordinates', () => {
    expect(calculateDistance(16.05, 108.2, 16.05, 108.2)).toBeLessThan(1);
  });

  it('matches a known short distance within tolerance', () => {
    // ~111 m per 0.001° of latitude near the equator.
    const metres = calculateDistance(16.0, 108.2, 16.001, 108.2);
    expect(metres).toBeGreaterThan(105);
    expect(metres).toBeLessThan(120);
  });

  it('is symmetric', () => {
    const a = calculateDistance(21.0285, 105.8542, 16.0544, 108.2022);
    const b = calculateDistance(16.0544, 108.2022, 21.0285, 105.8542);
    expect(Math.abs(a - b)).toBeLessThan(1);
  });
});

describe('toISODateString', () => {
  it('formats a date as YYYY-MM-DD in local time', () => {
    expect(toISODateString(new Date(2026, 8, 9))).toBe('2026-09-09');
    expect(toISODateString(new Date(2026, 0, 1))).toBe('2026-01-01');
  });
});

describe('formatDateString', () => {
  it('formats ISO strings as DD/MM/YYYY', () => {
    expect(formatDateString('2026-09-09')).toBe('09/09/2026');
  });

  it('returns an empty string for invalid input', () => {
    expect(formatDateString('not-a-date')).toBe('');
    expect(formatDateString(null)).toBe('');
  });
});

describe('feedback preferences', () => {
  afterEach(() => {
    setFeedbackPrefs({ haptics: true, sound: true });
  });

  it('defaults to enabled', () => {
    expect(getFeedbackPrefs()).toEqual({ haptics: true, sound: true });
  });

  it('merges partial updates', () => {
    setFeedbackPrefs({ sound: false });
    expect(getFeedbackPrefs()).toEqual({ haptics: true, sound: false });
    setFeedbackPrefs({ haptics: false });
    expect(getFeedbackPrefs()).toEqual({ haptics: false, sound: false });
  });
});
