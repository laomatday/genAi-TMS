import { STATION_GREETINGS, TMS_TIME } from '@/shared/constants';

/**
 * The derived values behind the station display, kept out of the view so the
 * wording, the boundaries and the maths are each one testable thing.
 */

/** Greeting for a local hour, from the configured table. */
export function stationGreeting(hour: number): string {
  const normalized = Number.isFinite(hour) ? Math.min(23, Math.max(0, Math.floor(hour))) : 0;
  const match = STATION_GREETINGS.find((entry) => normalized < entry.untilHour);
  return match?.label ?? STATION_GREETINGS[STATION_GREETINGS.length - 1]?.label ?? '';
}

/**
 * How much of the code's life is left, as 0–1, for the ring drawn around it.
 * Clamped because the countdown is a rounded second against a validity window
 * the server can change underneath it.
 */
export function countdownRatio(secondsLeft: number, validitySeconds: number): number {
  if (!Number.isFinite(secondsLeft) || !Number.isFinite(validitySeconds) || validitySeconds <= 0) return 0;
  return Math.min(1, Math.max(0, secondsLeft / validitySeconds));
}

/** True once the code is close enough to expiring to say so in colour. */
export function isCountdownUrgent(secondsLeft: number, validitySeconds: number, urgentFraction = 0.2): boolean {
  if (validitySeconds <= 0) return false;
  return secondsLeft <= Math.ceil(validitySeconds * urgentFraction);
}

const clock = new Intl.DateTimeFormat(TMS_TIME.LOCALE, {
  timeZone: TMS_TIME.ZONE,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

const fullDate = new Intl.DateTimeFormat(TMS_TIME.LOCALE, {
  timeZone: TMS_TIME.ZONE,
  weekday: 'long',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

export function stationClock(value: Date): string {
  return clock.format(value);
}

export function stationDate(value: Date): string {
  const text = fullDate.format(value);
  return text.charAt(0).toLocaleUpperCase(TMS_TIME.LOCALE) + text.slice(1);
}

/** The station's own hour, which is the tenant's, not the device's. */
export function stationHour(value: Date): number {
  return Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: TMS_TIME.ZONE,
    hour: '2-digit',
    hour12: false,
  }).format(value));
}
