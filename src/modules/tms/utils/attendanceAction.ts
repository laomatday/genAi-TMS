/** What the home screen's main button offers, given today's attendance state. */
export interface AttendanceAction {
  kind: 'checkout' | 'checkin';
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
 * There is no paused state either. Mid-shift pause was removed: see the
 * migration that took it off the server for why, in short that it was used
 * eight times and resumed once, and the seven that were not resumed had the
 * rest of the day deducted as unpaid break.
 *
 * So there is no separate "start another shift" state, and deliberately so:
 * check-in reads the same whether it is the first of the day or the third. The
 * one that distinguished them had to explain itself in the label, which wrapped
 * to four lines inside a circular button and made an ordinary action look like
 * an exception. Which session this opens is the server's business, and the
 * history below says how many there have been.
 */
export function resolveAttendanceAction(state: {
  working: boolean;
}): AttendanceAction {
  if (state.working) {
    return { kind: 'checkout', label: 'Check-out', hint: 'Chạm để xác nhận', icon: 'logout' };
  }
  return { kind: 'checkin', label: 'Chấm công', hint: 'Chạm để quét QR', icon: 'qr_code_scanner' };
}
