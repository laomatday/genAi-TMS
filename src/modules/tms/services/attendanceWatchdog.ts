/**
 * A time limit on how long the attendance lock may be held.
 *
 * Check-in and check-out take a lock that disables the pager and puts a
 * blocking overlay on screen, and release it in a `finally`. That release only
 * runs once the awaited promises settle, and the Supabase RPC has no timeout:
 * when the connection dies while the phone has the app in the background — the
 * socket is gone but nothing errors — the request can stay pending
 * indefinitely. The lock is then held for the rest of the session, which is why
 * returning to the app leaves it unable to swipe and unable to clock in again.
 *
 * The watchdog never cancels the request. It only stops the interface being
 * held hostage by one, and says plainly that the outcome is unknown. Retrying
 * is safe: every attendance command carries a durable command_id, so the server
 * treats a repeat as the same command rather than a second punch.
 */

export interface AttendanceWatchdog {
  /** Begins the countdown. Starting again restarts it. */
  arm: () => void;
  /** The transaction finished normally. */
  disarm: () => void;
  /** Fires the expiry now if the countdown is running — used when the app comes
   *  back to the foreground, because a phone that suspended the page also
   *  suspended the timer that was supposed to catch this. */
  expireIfOverdue: (now?: number) => void;
}

export interface WatchdogClock {
  now: () => number;
  setTimer: (run: () => void, ms: number) => number;
  clearTimer: (handle: number) => void;
}

const systemClock: WatchdogClock = {
  now: () => Date.now(),
  setTimer: (run, ms) => window.setTimeout(run, ms),
  clearTimer: (handle) => window.clearTimeout(handle),
};

export function createAttendanceWatchdog(
  timeoutMs: number,
  onExpire: () => void,
  clock: WatchdogClock = systemClock,
): AttendanceWatchdog {
  let handle: number | null = null;
  let armedAt: number | null = null;

  const stop = () => {
    if (handle !== null) clock.clearTimer(handle);
    handle = null;
    armedAt = null;
  };

  const expire = () => {
    if (armedAt === null) return;
    stop();
    onExpire();
  };

  return {
    arm: () => {
      stop();
      armedAt = clock.now();
      handle = clock.setTimer(expire, timeoutMs);
    },
    disarm: stop,
    expireIfOverdue: (now = clock.now()) => {
      if (armedAt === null) return;
      if (now - armedAt < timeoutMs) return;
      expire();
    },
  };
}
