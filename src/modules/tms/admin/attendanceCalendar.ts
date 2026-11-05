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
  /** Server-certified credit only once on the first session of each day. */
  dayCredit?: number | null;
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
      for (const [index, timesheet] of sessions.entries()) {
        const policy = timesheet.policy_id ? policies.get(timesheet.policy_id) : undefined;
        const targetMinutes = scheduledMinutes(timesheet, policy?.unpaid_break_minutes ?? 0);
        const rawCredit = timesheet.day_work_credit;
        const dayCredit = rawCredit == null || !Number.isFinite(Number(rawCredit)) || Number(rawCredit) < 0
          ? null
          : Number(rawCredit);
        rows.push({
          employeeId, workDate, employee, timesheet, targetMinutes,
          overtimeMinutes: Math.max(0, (timesheet.work_minutes || 0) - targetMinutes),
          dayCredit: index === 0 ? dayCredit : undefined,
        });
      }
    }
  }
  return rows;
}

export interface MonthlyAttendanceSummary {
  employeeId: string;
  employee?: Employee;
  month: string;
  daysInMonth: number;
  /** Sum of server day_work_credit, not a count of shift records. */
  workDays: number;
  recordedDays: number;
  missingDays: number;
  futureDays: number;
  outsideEmploymentDays: number;
  unknownCreditDays: number;
  reviewDays: number;
  lockedDays: number;
  totalWorkMinutes: number;
  standardMinutes: number;
  lateMinutes: number;
  earlyMinutes: number;
  overtimeMinutes: number;
  /** Number or blank per calendar day, ? if the backend did not supply credit. */
  dailyCredits: Array<number | '' | '?'>;
}

const REVIEW_STATUSES = new Set(['EXCEPTION', 'REJECTED', 'PENDING_REVIEW']);

/** Generate one employee/month summary from precisely the same detail rows. */
export function summarizeAttendanceMonth(
  month: string,
  rows: AttendanceExportRow[],
): MonthlyAttendanceSummary[] {
  const daysInMonth = Number(monthRange(month).to.slice(-2));
  const totals = new Map<string, MonthlyAttendanceSummary>();
  const recordedDates = new Set<string>();
  const reviewDates = new Set<string>();
  const lockedDates = new Set<string>();
  for (const row of rows) {
    let summary = totals.get(row.employeeId);
    if (!summary) {
      summary = {
        employeeId: row.employeeId,
        employee: row.employee,
        month,
        daysInMonth,
        workDays: 0,
        recordedDays: 0,
        missingDays: 0,
        futureDays: 0,
        outsideEmploymentDays: 0,
        unknownCreditDays: 0,
        reviewDays: 0,
        lockedDays: 0,
        totalWorkMinutes: 0,
        standardMinutes: 0,
        lateMinutes: 0,
        earlyMinutes: 0,
        overtimeMinutes: 0,
        dailyCredits: Array.from({ length: daysInMonth }, () => ''),
      };
      totals.set(row.employeeId, summary);
    }
    if (!row.timesheet) {
      if (row.missingStatus === 'Chưa có dữ liệu') summary.missingDays += 1;
      if (row.missingStatus === 'Chưa đến ngày') summary.futureDays += 1;
      if (row.missingStatus === 'Ngoài thời gian làm việc') summary.outsideEmploymentDays += 1;
      continue;
    }
    const session = row.timesheet;
    const key = `${row.employeeId}:${row.workDate}`;
    const index = Number(row.workDate.slice(-2)) - 1;
    if (!recordedDates.has(key)) {
      recordedDates.add(key);
      summary.recordedDays += 1;
      // The first real session of a day is the only place containing a credit.
      if (row.dayCredit == null) {
        summary.unknownCreditDays += 1;
        summary.dailyCredits[index] = '?';
      } else {
        summary.workDays += row.dayCredit;
        summary.dailyCredits[index] = row.dayCredit;
      }
    }
    summary.totalWorkMinutes += Number(session.work_minutes || 0);
    summary.standardMinutes += row.targetMinutes || 0;
    summary.lateMinutes += Number(session.late_minutes || 0);
    summary.earlyMinutes += Number(session.early_minutes || 0);
    summary.overtimeMinutes += row.overtimeMinutes || 0;
    if (!reviewDates.has(key) && (session.exception_codes?.length || REVIEW_STATUSES.has(session.status))) {
      reviewDates.add(key);
      summary.reviewDays += 1;
    }
    if (!lockedDates.has(key) && session.status === 'LOCKED') {
      lockedDates.add(key);
      summary.lockedDays += 1;
    }
  }
  return [...totals.values()].sort((a, b) => a.employeeId.localeCompare(b.employeeId));
}
