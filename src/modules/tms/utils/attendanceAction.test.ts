import { describe, expect, it } from 'vitest';
import { resolveAttendanceAction } from './attendanceAction';

describe('resolveAttendanceAction', () => {
  it('offers check-in before the first session of the day', () => {
    expect(resolveAttendanceAction({ paused: false, working: false, checkedOut: false }))
      .toMatchObject({ kind: 'checkin', label: 'Chấm công' });
  });

  it('offers check-out while a session is open', () => {
    expect(resolveAttendanceAction({ paused: false, working: true, checkedOut: false }))
      .toMatchObject({ kind: 'checkout' });
  });

  it('offers a new session after checking out, instead of locking the day', () => {
    // The whole point: someone who checked out in the morning and came back
    // after lunch must be able to record the afternoon. The server opens the
    // next session in sequence; the screen used to disable the button.
    const action = resolveAttendanceAction({ paused: false, working: false, checkedOut: true });
    expect(action.kind).toBe('recheckin');
    expect(action.label).toBe('Vào ca mới');
  });

  it('resumes a paused session rather than starting anything new', () => {
    expect(resolveAttendanceAction({ paused: true, working: true, checkedOut: false }))
      .toMatchObject({ kind: 'resume' });
    expect(resolveAttendanceAction({ paused: true, working: false, checkedOut: true }))
      .toMatchObject({ kind: 'resume' });
  });
});
