import { describe, expect, it } from 'vitest';
import { resolveAttendanceAction } from './attendanceAction';

describe('resolveAttendanceAction', () => {
  it('offers check-in before the first session of the day', () => {
    expect(resolveAttendanceAction({ paused: false, working: false }))
      .toMatchObject({ kind: 'checkin', label: 'Chấm công' });
  });

  it('offers check-out while a session is open', () => {
    expect(resolveAttendanceAction({ paused: false, working: true }))
      .toMatchObject({ kind: 'checkout' });
  });

  it('offers the same check-in after a session has been closed', () => {
    // The point of the whole module: someone who checked out in the morning and
    // came back after lunch must be able to record the afternoon. The screen
    // used to disable the button here and lock the rest of the day.
    expect(resolveAttendanceAction({ paused: false, working: false }))
      .toMatchObject({ kind: 'checkin', label: 'Chấm công' });
  });

  it('resumes a paused session rather than starting anything new', () => {
    expect(resolveAttendanceAction({ paused: true, working: true }))
      .toMatchObject({ kind: 'resume' });
    expect(resolveAttendanceAction({ paused: true, working: false }))
      .toMatchObject({ kind: 'resume' });
  });
});
