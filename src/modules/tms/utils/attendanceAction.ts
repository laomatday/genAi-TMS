/** What the home screen's main button offers, given today's attendance state. */
export interface AttendanceAction {
  kind: 'resume' | 'checkout' | 'checkin' | 'recheckin';
  label: string;
  hint: string;
  icon: string;
}

/**
 * Having checked out is not the end of the day.
 *
 * The screen used to disable the button once a session closed — "Đã hoàn tất",
 * nothing to tap. Anyone who checked out at lunch and came back in the
 * afternoon was then stuck: no way to record the second half except by filing
 * an explanation for a day they had actually worked. A morning mis-tap had the
 * same effect and cost the rest of the day.
 *
 * The server never required that. A check-in is refused only while a session is
 * still open; with none open it opens the next one, numbered in sequence, up to
 * thirty-two a day. Split shifts are recorded correctly and always were — the
 * button was the only thing in the way.
 *
 * Re-entry is offered unconditionally rather than only inside the shift window,
 * because checking in means scanning a QR code at the branch. That is a
 * deliberate act, not a mis-tap, and the cost of guessing the window wrong is
 * exactly the situation this replaces.
 */
export function resolveAttendanceAction(state: {
  paused: boolean;
  working: boolean;
  checkedOut: boolean;
}): AttendanceAction {
  if (state.paused) {
    return { kind: 'resume', label: 'Tiếp tục làm việc', hint: 'Chạm để tiếp tục', icon: 'play_arrow' };
  }
  if (state.working) {
    return { kind: 'checkout', label: 'Check-out', hint: 'Chạm để xác nhận', icon: 'logout' };
  }
  if (state.checkedOut) {
    // Named for what it does rather than repeated as plain "Chấm công", so the
    // screen still says a session was completed while offering the next one.
    return { kind: 'recheckin', label: 'Vào ca mới', hint: 'Đã xong ca trước · chạm để quét QR', icon: 'qr_code_scanner' };
  }
  return { kind: 'checkin', label: 'Chấm công', hint: 'Chạm để quét QR', icon: 'qr_code_scanner' };
}
