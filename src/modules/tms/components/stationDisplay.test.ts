import { describe, expect, it } from 'vitest';
import {
  countdownRatio,
  isCountdownUrgent,
  stationClock,
  stationDate,
  stationGreeting,
  stationHour,
} from './stationDisplay';
import { STATION_GREETINGS } from '@/shared/constants';

describe('stationGreeting', () => {
  it('follows the configured table rather than wording baked into the view', () => {
    expect(stationGreeting(7)).toBe('Chào buổi sáng');
    expect(stationGreeting(12)).toBe('Chào buổi trưa');
    expect(stationGreeting(15)).toBe('Chào buổi chiều');
    expect(stationGreeting(21)).toBe('Chào buổi tối');
  });

  it('treats each boundary as the start of the next span', () => {
    expect(stationGreeting(10)).toBe('Chào buổi sáng');
    expect(stationGreeting(11)).toBe('Chào buổi trưa');
    expect(stationGreeting(13)).toBe('Chào buổi chiều');
    expect(stationGreeting(18)).toBe('Chào buổi tối');
  });

  it('covers every hour of the day', () => {
    for (let hour = 0; hour < 24; hour += 1) {
      expect(stationGreeting(hour)).not.toBe('');
    }
    // The table has to close the day, or the last hours fall through.
    expect(STATION_GREETINGS[STATION_GREETINGS.length - 1]?.untilHour).toBe(24);
  });

  it('survives a nonsense hour instead of showing nothing', () => {
    expect(stationGreeting(Number.NaN)).toBe('Chào buổi sáng');
    expect(stationGreeting(-3)).toBe('Chào buổi sáng');
    expect(stationGreeting(99)).toBe('Chào buổi tối');
  });
});

describe('countdownRatio', () => {
  it('reports the share of the window still left', () => {
    expect(countdownRatio(45, 45)).toBe(1);
    expect(countdownRatio(9, 45)).toBeCloseTo(0.2);
    expect(countdownRatio(0, 45)).toBe(0);
  });

  it('clamps, because the server can shorten the window under a running count', () => {
    expect(countdownRatio(60, 45)).toBe(1);
    expect(countdownRatio(-5, 45)).toBe(0);
  });

  it('returns nothing to draw when the window is unknown', () => {
    expect(countdownRatio(10, 0)).toBe(0);
    expect(countdownRatio(Number.NaN, 45)).toBe(0);
  });
});

describe('isCountdownUrgent', () => {
  it('turns urgent in the last fifth of the window', () => {
    expect(isCountdownUrgent(10, 45)).toBe(false);
    expect(isCountdownUrgent(9, 45)).toBe(true);
    expect(isCountdownUrgent(1, 45)).toBe(true);
  });

  it('never claims urgency without a window', () => {
    expect(isCountdownUrgent(0, 0)).toBe(false);
  });
});

describe('station clock and date', () => {
  // 2026-09-16T00:48:00Z is 07:48 in Asia/Ho_Chi_Minh.
  const moment = new Date('2026-09-16T00:48:00Z');

  it('reads the tenant clock, not the device clock', () => {
    expect(stationClock(moment)).toBe('07:48:00');
    expect(stationHour(moment)).toBe(7);
  });

  it('writes the date with the weekday, capitalised', () => {
    const text = stationDate(moment);
    expect(text).toContain('16/09/2026');
    expect(text.charAt(0)).toBe(text.charAt(0).toLocaleUpperCase('vi-VN'));
  });

  it('keeps a late UTC evening on the next local day', () => {
    // 17:10Z is 00:10 the following morning in Vietnam; a station that showed
    // the UTC date would put the wrong day on the wall overnight.
    const lateEvening = new Date('2026-09-16T17:10:00Z');
    expect(stationClock(lateEvening)).toBe('00:10:00');
    expect(stationDate(lateEvening)).toContain('17/09/2026');
    expect(stationGreeting(stationHour(lateEvening))).toBe('Chào buổi sáng');
  });
});
