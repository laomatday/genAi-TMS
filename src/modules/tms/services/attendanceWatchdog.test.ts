import { describe, expect, it, vi } from 'vitest';
import { createAttendanceWatchdog, type WatchdogClock } from './attendanceWatchdog';

function fakeClock() {
  let time = 0;
  const timers = new Map<number, { run: () => void; at: number }>();
  let nextHandle = 1;
  const clock: WatchdogClock = {
    now: () => time,
    setTimer: (run, ms) => {
      const handle = nextHandle;
      nextHandle += 1;
      timers.set(handle, { run, at: time + ms });
      return handle;
    },
    clearTimer: (handle) => { timers.delete(handle); },
  };
  return {
    clock,
    advance(ms: number) {
      time += ms;
      for (const [handle, timer] of [...timers]) {
        if (timer.at <= time) { timers.delete(handle); timer.run(); }
      }
    },
    set(ms: number) { time = ms; },
    pending: () => timers.size,
  };
}

describe('createAttendanceWatchdog', () => {
  it('releases the lock when the request never answers', () => {
    const onExpire = vi.fn();
    const timer = fakeClock();
    const watchdog = createAttendanceWatchdog(45_000, onExpire, timer.clock);

    watchdog.arm();
    timer.advance(44_000);
    expect(onExpire).not.toHaveBeenCalled();
    timer.advance(2_000);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('stays quiet when the transaction finishes in time', () => {
    const onExpire = vi.fn();
    const timer = fakeClock();
    const watchdog = createAttendanceWatchdog(45_000, onExpire, timer.clock);

    watchdog.arm();
    timer.advance(5_000);
    watchdog.disarm();
    timer.advance(60_000);
    expect(onExpire).not.toHaveBeenCalled();
    expect(timer.pending()).toBe(0);
  });

  it('fires only once, however long the request stays pending', () => {
    const onExpire = vi.fn();
    const timer = fakeClock();
    const watchdog = createAttendanceWatchdog(1_000, onExpire, timer.clock);

    watchdog.arm();
    timer.advance(10_000);
    timer.advance(10_000);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('catches the overdue lock when the phone suspended the timer', () => {
    // A backgrounded page has its timers frozen, so the countdown that was
    // meant to catch this never runs. The foreground check is what closes that
    // gap, and it is the whole reason the bug looks like "came back and the app
    // was dead".
    const onExpire = vi.fn();
    const timer = fakeClock();
    const watchdog = createAttendanceWatchdog(45_000, onExpire, timer.clock);

    watchdog.arm();
    timer.set(600_000);
    watchdog.expireIfOverdue();
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('leaves a young lock alone when the app returns quickly', () => {
    const onExpire = vi.fn();
    const timer = fakeClock();
    const watchdog = createAttendanceWatchdog(45_000, onExpire, timer.clock);

    watchdog.arm();
    timer.set(3_000);
    watchdog.expireIfOverdue();
    expect(onExpire).not.toHaveBeenCalled();
  });

  it('does nothing when it was never armed', () => {
    const onExpire = vi.fn();
    const timer = fakeClock();
    const watchdog = createAttendanceWatchdog(45_000, onExpire, timer.clock);

    watchdog.expireIfOverdue();
    timer.advance(100_000);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it('restarts the countdown when a new transaction begins', () => {
    const onExpire = vi.fn();
    const timer = fakeClock();
    const watchdog = createAttendanceWatchdog(10_000, onExpire, timer.clock);

    watchdog.arm();
    timer.advance(8_000);
    watchdog.arm();
    timer.advance(8_000);
    expect(onExpire).not.toHaveBeenCalled();
    timer.advance(4_000);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });
});
