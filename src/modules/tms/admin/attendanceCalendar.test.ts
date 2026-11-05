import { describe, expect, it } from 'vitest';
import type { Employee } from '@/shared/types';
import type { Timesheet } from './types';
import { buildAttendanceExportRows, summarizeAttendanceMonth } from './attendanceCalendar';

function employee(employeeId: string, overrides: Partial<Employee> = {}): Employee {
  return {
    id: employeeId,
    employee_id: employeeId,
    name: employeeId,
    email: `${employeeId}@example.com`,
    role: 'Staff',
    center_id: 'DN',
    status: 'Active',
    ...overrides,
  };
}

function session(employeeId: string, workDate: string, id = 'session'): Timesheet {
  return {
    id,
    employee_id: employeeId,
    work_date: workDate,
    status: 'APPROVED',
    source: 'NORMAL',
    exception_codes: [],
    late_minutes: 0,
    early_minutes: 0,
    work_minutes: 240,
    day_work_credit: 0.5,
  };
}

describe('monthly attendance Excel calendar', () => {
  it.each([
    ['2025-02', 28],
    ['2024-02', 29],
    ['2026-04', 30],
    ['2026-12', 31],
  ])('includes every calendar day in %s (%i days) even with no records', (month, days) => {
    const rows = buildAttendanceExportRows({
      month,
      employees: [employee('E1')],
      timesheets: [],
      policies: [],
    }, '2027-01-01');
    expect(rows).toHaveLength(days);
    expect(rows[0]?.workDate).toBe(`${month}-01`);
    expect(rows[rows.length - 1]?.workDate).toBe(`${month}-${String(days).padStart(2, '0')}`);
    expect(rows.every((row) => !row.timesheet && row.missingStatus === 'Chưa có dữ liệu')).toBe(true);
  });

  it('preserves multiple sessions per day without creating extra fictitious work time', () => {
    const first = session('E1', '2024-02-01', 'morning');
    const second = session('E1', '2024-02-01', 'afternoon');
    const end = session('E1', '2024-02-29', 'end');
    const rows = buildAttendanceExportRows({
      month: '2024-02',
      employees: [employee('E1'), employee('E2')],
      timesheets: [first, second, end],
      policies: [],
    }, '2025-01-01');
    expect(rows).toHaveLength(59); // 29 dates x 2 people, plus a second session on day 1.
    expect(rows.filter((row) => row.employeeId === 'E1' && row.workDate === '2024-02-01')
      .map((row) => row.timesheet?.id)).toEqual(['morning', 'afternoon']);
    expect(rows.find((row) => row.employeeId === 'E1' && row.workDate === '2024-02-29')?.timesheet?.id).toBe('end');
    expect(rows.find((row) => row.employeeId === 'E2' && row.workDate === '2024-02-01')).toMatchObject({
      missingStatus: 'Chưa có dữ liệu',
    });
    expect(rows.filter((row) => !row.timesheet).every((row) =>
      row.targetMinutes === undefined && row.overtimeMinutes === undefined)).toBe(true);
  });

  it('distinguishes future dates and dates outside the employee contract; excludes empty Kiosk accounts', () => {
    const rows = buildAttendanceExportRows({
      month: '2026-11',
      employees: [
        employee('E1', { employment_start_date: '2026-11-03', employment_end_date: '2026-11-20' }),
        employee('K1', { role: 'Kiosk' }),
      ],
      timesheets: [],
      policies: [],
    }, '2026-11-05');
    expect(rows).toHaveLength(30);
    expect(rows.find((row) => row.workDate === '2026-11-01')?.missingStatus).toBe('Ngoài thời gian làm việc');
    expect(rows.find((row) => row.workDate === '2026-11-04')?.missingStatus).toBe('Chưa có dữ liệu');
    expect(rows.find((row) => row.workDate === '2026-11-06')?.missingStatus).toBe('Chưa đến ngày');
    expect(rows.find((row) => row.workDate === '2026-11-21')?.missingStatus).toBe('Ngoài thời gian làm việc');
  });

  it('keeps session owners missing from the employee list, but ignores records from another month', () => {
    const rows = buildAttendanceExportRows({
      month: '2026-11',
      employees: [],
      timesheets: [session('LEGACY', '2026-11-30'), session('OTHER', '2026-10-31')],
      policies: [],
    }, '2026-12-01');
    expect(rows).toHaveLength(30);
    expect(rows.every((row) => row.employeeId === 'LEGACY')).toBe(true);
    expect(rows[rows.length - 1]?.timesheet?.work_date).toBe('2026-11-30');
  });
});

describe('monthly employee work-day report', () => {
  it('counts daily credit once for split shifts and sums work minutes across all sessions', () => {
    const morning = { ...session('E1', '2026-11-03', 'morning'), day_work_credit: 1, work_minutes: 210 };
    const afternoon = { ...session('E1', '2026-11-03', 'afternoon'), day_work_credit: 1, work_minutes: 240 };
    const half = { ...session('E1', '2026-11-04', 'half'), day_work_credit: 0.5, work_minutes: 240 };
    const rows = buildAttendanceExportRows({
      month: '2026-11',
      employees: [employee('E1'), employee('E2')],
      timesheets: [morning, afternoon, half],
      policies: [],
    }, '2026-12-01');
    const summaries = summarizeAttendanceMonth('2026-11', rows);
    expect(summaries).toHaveLength(2);
    const first = summaries[0]!;
    expect(first.employeeId).toBe('E1');
    expect(first.recordedDays).toBe(2);
    expect(first.workDays).toBe(1.5);
    expect(first.totalWorkMinutes).toBe(690);
    expect(first.dailyCredits[2]).toBe(1);
    expect(first.dailyCredits[3]).toBe(0.5);
    expect(first.missingDays).toBe(28);
    expect(summaries[1]).toMatchObject({ employeeId: 'E2', workDays: 0, recordedDays: 0, missingDays: 30 });
    expect(rows.filter((row) => row.employeeId === 'E1' && row.workDate === '2026-11-03')
      .map((row) => row.dayCredit)).toEqual([1, undefined]);
  });

  it('does not silently count missing server day credit as zero work days', () => {
    const unknown = { ...session('E1', '2026-11-03'), day_work_credit: undefined };
    const rows = buildAttendanceExportRows({
      month: '2026-11',
      employees: [employee('E1')],
      timesheets: [unknown],
      policies: [],
    }, '2026-12-01');
    expect(summarizeAttendanceMonth('2026-11', rows)[0]).toMatchObject({
      workDays: 0,
      unknownCreditDays: 1,
      recordedDays: 1,
    });
    expect(summarizeAttendanceMonth('2026-11', rows)[0]!.dailyCredits[2]).toBe('?');
  });

  it('counts review and locked dates, not shift rows, and separates future and contract boundaries', () => {
    const review1 = { ...session('E1', '2026-11-04', 'a'), status: 'EXCEPTION' as const, exception_codes: ['LATE'] };
    const review2 = { ...session('E1', '2026-11-04', 'b'), status: 'EXCEPTION' as const, exception_codes: ['EARLY_LEAVE'] };
    const locked1 = { ...session('E1', '2026-11-05', 'c'), status: 'LOCKED' as const };
    const locked2 = { ...session('E1', '2026-11-05', 'd'), status: 'LOCKED' as const };
    const rows = buildAttendanceExportRows({
      month: '2026-11',
      employees: [employee('E1', { employment_start_date: '2026-11-03', employment_end_date: '2026-11-20' })],
      timesheets: [review1, review2, locked1, locked2],
      policies: [],
    }, '2026-11-06');
    const summary = summarizeAttendanceMonth('2026-11', rows)[0]!;
    expect(summary.reviewDays).toBe(1);
    expect(summary.lockedDays).toBe(1);
    expect(summary.workDays).toBe(1);
    expect(summary.outsideEmploymentDays).toBe(12);
    expect(summary.futureDays).toBe(14);
    expect(summary.missingDays).toBe(2); // 3rd and 6th.
  });
});
