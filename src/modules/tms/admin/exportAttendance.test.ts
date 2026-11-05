import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Employee } from '@/shared/types';
import type { Timesheet } from './types';

const writer = vi.hoisted(() => ({
  sheets: undefined as unknown,
  toFile: vi.fn(async () => undefined),
}));

vi.mock('write-excel-file/browser', () => ({
  default: (sheets: unknown) => {
    writer.sheets = sheets;
    return { toFile: writer.toFile };
  },
}));

import { exportAttendanceExcel, exportPayrollExcel } from './exportAttendance';

const employee: Employee = {
  id: 'E1',
  employee_id: 'E1',
  name: 'Nguyễn Văn A',
  email: 'e1@example.com',
  role: 'Staff',
  center_id: 'DN',
  status: 'Active',
};

const session: Timesheet = {
  id: 's1',
  employee_id: 'E1',
  work_date: '2026-11-05',
  status: 'COMPLETE',
  source: 'NORMAL',
  work_minutes: 240,
  late_minutes: 0,
  early_minutes: 0,
  exception_codes: [],
  day_work_credit: 0.5,
};

type TestSheet = {
  sheet: string;
  data: Array<Array<{ value?: unknown }>>;
};

beforeEach(() => {
  writer.sheets = undefined;
  writer.toFile.mockClear();
  vi.stubGlobal('getComputedStyle', () => ({
    getPropertyValue: (token: string) => token === '--brand-navy' ? '#002744'
      : token === '--color-on-dark' ? '#FFFFFF' : '#DDEEFF',
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe('actual monthly attendance XLSX sheets', () => {
  it('exports a monthly total, day-credit matrix and real-session detail in one file', async () => {
    await exportAttendanceExcel({
      month: '2026-11',
      employees: [employee],
      timesheets: [session],
      policies: [],
      dayCredits: [
        { employee_id: 'E1', work_date: '2026-11-03', work_credit: 1, status: 'SCHEDULED' },
        { employee_id: 'E1', work_date: '2026-11-05', work_credit: 0.5, status: 'COMPLETE' },
      ],
    });
    const sheets = writer.sheets as TestSheet[];
    expect(sheets.map((sheet) => sheet.sheet)).toEqual(['Tổng hợp công', 'Công theo ngày', 'Chi tiết ca']);
    expect(sheets[0]!.data[1]![5]!.value).toBe(1.5); // Total canonical day credit
    expect(sheets[1]!.data[1]![5]!.value).toBe(1); // Nov 03; columns A-C are metadata
    expect(sheets[1]!.data[1]![7]!.value).toBe(0.5); // Nov 05
    expect(sheets[2]!.data).toHaveLength(31); // 30 calendar dates (one real shift) + header
    expect(writer.toFile).toHaveBeenCalledWith('bang-cong-2026-11.xlsx');
  });

  it('payroll has each employee even when there are no work sessions', async () => {
    await exportPayrollExcel({
      month: '2026-11',
      employees: [employee],
      timesheets: [],
      policies: [],
      dayCredits: [{ employee_id: 'E1', work_date: '2026-11-03', work_credit: 1 }],
      closed: false,
    });
    const sheets = writer.sheets as TestSheet[];
    expect(sheets.map((sheet) => sheet.sheet)).toEqual(['Payroll', 'Công theo ngày', 'Chi tiết ca']);
    expect(sheets[0]!.data).toHaveLength(2);
    expect(sheets[0]!.data[1]![6]!.value).toBe(1);
    expect(sheets[0]!.data[1]![1]!.value).toBe('Bản nháp');
    expect(writer.toFile).toHaveBeenCalledWith('payroll-2026-11-draft.xlsx');
  });
});
