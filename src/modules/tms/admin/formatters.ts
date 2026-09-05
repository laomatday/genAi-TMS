import { ATTENDANCE_STATUS_LABELS, EXCEPTION_LABELS } from './constants';
import type { Timesheet, TimesheetStatus } from './types';

const dateFormatter = new Intl.DateTimeFormat('vi-VN');
const dateTimeFormatter = new Intl.DateTimeFormat('vi-VN', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
const clockFormatter = new Intl.DateTimeFormat('vi-VN', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export function formatClock(value?: string | null) {
  return value ? clockFormatter.format(new Date(value)) : '--:--';
}

export function formatDate(value: string) {
  return dateFormatter.format(new Date(`${value}T00:00:00`));
}

export function formatDateTime(value?: string | null) {
  return value ? dateTimeFormatter.format(new Date(value)) : '—';
}

export function formatHours(minutes = 0) {
  return `${(minutes / 60).toLocaleString('vi-VN', { maximumFractionDigits: 2 })}h`;
}

export function formatStatus(status: TimesheetStatus) {
  return ATTENDANCE_STATUS_LABELS[status] || status;
}

export function formatExceptions(codes: string[]) {
  if (!codes.length) return '—';
  return codes.map((code) => EXCEPTION_LABELS[code] || code).join(', ');
}

export function monthRange(month: string) {
  const parts = month.split('-');
  const year = Number(parts[0]);
  const monthNumber = Number(parts[1]);
  if (!Number.isInteger(year) || !Number.isInteger(monthNumber) || monthNumber < 1 || monthNumber > 12) {
    throw new Error('Tháng báo cáo không hợp lệ.');
  }
  const lastDay = new Date(year, monthNumber, 0).getDate();
  return { from: `${month}-01`, to: `${month}-${String(lastDay).padStart(2, '0')}` };
}

export function scheduledMinutes(timesheet: Timesheet, unpaidBreakMinutes = 0) {
  if (!timesheet.expected_start || !timesheet.expected_end) return 0;
  const start = new Date(timesheet.expected_start).getTime();
  const end = new Date(timesheet.expected_end).getTime();
  return Math.max(0, Math.round((end - start) / 60_000) - unpaidBreakMinutes);
}
