import type { Employee } from '@/shared/types';
import { monthRange, scheduledMinutes } from './formatters';
import type { AttendancePolicy, Timesheet } from './types';

/** A missing calendar day is an empty export row, never a fabricated timesheet. */
export interface AttendanceExportRow {
  employeeId: string;
  workDate: string;
  employee?: Employee;
  timesheet?: Timesheet;
  targetMinutes?: number;
  overtimeMinutes?: number;
  missingStatus?: string;
}

interface AttendanceCalendarInput {
  month: string;
  timesheets: Timesheet[];
  employees: Employee[];
  policies: AttendancePolicy[];
}

function vietnamToday() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const part = (type: string) => parts.find((item) => item.type === type)?.value || '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function missingDayStatus(employee: Employee | undefined, date: string, today: string) {
  const start = (employee?.employment_start_date || employee?.join_date || '').slice(0, 10);
  const end = (employee?.employment_end_date || '').slice(0, 10);
  if ((start && date < start) || (end && date > end)) return 'Ngoài thời gian làm việc';
  if (date > today) return 'Chưa đến ngày';
  return 'Chưa có dữ liệu';
}

/**
 * Output every date from day 1 through the last day for every visible employee.
 * Existing sessions stay separate (including split shifts); only absent dates
 * get blank rows. Missing rows must not contribute attendance/payroll credit.
 */
export function buildAttendanceExportRows(input: AttendanceCalendarInput, today = vietnamToday()): AttendanceExportRow[] {
  const range = monthRange(input.month);
  const daysInMonth = Number(range.to.slice(-2));
  const people = new Map(input.employees
    .filter((employee) => employee.role !== 'Kiosk')
    .map((employee) => [employee.employee_id, employee]));
  const policies = new Map(input.policies.map((policy) => [policy.id, policy]));
  const sessionsByDay = new Map<string, Timesheet[]>();

  for (const timesheet of input.timesheets) {
    if (!timesheet.work_date || timesheet.work_date < range.from || timesheet.work_date > range.to) continue;
    const key = `${timesheet.employee_id}:${timesheet.work_date}`;
    const daySessions = sessionsByDay.get(key) || [];
    daySessions.push(timesheet);
    sessionsByDay.set(key, daySessions);
  }

  // Include session owners not present in the current directory snapshot too.
  const employeeIds = new Set([...people.keys(), ...input.timesheets
    .filter((row) => row.work_date >= range.from && row.work_date <= range.to)
    .map((row) => row.employee_id)]);
  const rows: AttendanceExportRow[] = [];
  for (const employeeId of [...employeeIds].sort((a, b) => a.localeCompare(b))) {
    const employee = people.get(employeeId);
    for (let day = 1; day <= daysInMonth; day += 1) {
      const workDate = `${input.month}-${String(day).padStart(2, '0')}`;
      const sessions = sessionsByDay.get(`${employeeId}:${workDate}`) || [];
      if (!sessions.length) {
        rows.push({ employeeId, workDate, employee, missingStatus: missingDayStatus(employee, workDate, today) });
        continue;
      }
      for (const timesheet of sessions) {
        const policy = timesheet.policy_id ? policies.get(timesheet.policy_id) : undefined;
        const targetMinutes = scheduledMinutes(timesheet, policy?.unpaid_break_minutes ?? 0);
        rows.push({
          employeeId, workDate, employee, timesheet, targetMinutes,
          overtimeMinutes: Math.max(0, (timesheet.work_minutes || 0) - targetMinutes),
        });
      }
    }
  }
  return rows;
}
