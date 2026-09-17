import { exportExcel, type ExcelColumn } from '@/core/utils/excel';
import type { Employee } from '@/shared/types';
import { formatClock, formatExceptions, formatStatus, scheduledMinutes } from './formatters';
import type { AttendancePolicy, Timesheet } from './types';

interface AttendanceExportRow {
  timesheet: Timesheet;
  employee?: Employee;
  targetMinutes: number;
  overtimeMinutes: number;
}

const ATTENDANCE_COLUMNS: ExcelColumn<AttendanceExportRow>[] = [
  { header: 'Mã nhân viên', width: 16, value: (row) => row.timesheet.employee_id },
  { header: 'Họ tên', width: 24, value: (row) => row.employee?.name || '' },
  { header: 'Phòng ban', width: 20, value: (row) => row.employee?.department || '' },
  { header: 'Chi nhánh', width: 16, value: (row) => row.employee?.center_id || '' },
  { header: 'Ngày công', width: 16, format: 'yyyy-mm-dd', value: (row) => new Date(`${row.timesheet.work_date}T00:00:00`) },
  { header: 'Giờ dự kiến', width: 18, value: (row) => `${formatClock(row.timesheet.expected_start)}–${formatClock(row.timesheet.expected_end)}` },
  { header: 'Check-in', width: 15, value: (row) => formatClock(row.timesheet.actual_checkin) },
  { header: 'Check-out', width: 15, value: (row) => formatClock(row.timesheet.actual_checkout) },
  { header: 'Giờ công', width: 14, format: '0.00', value: (row) => row.timesheet.work_minutes / 60 },
  { header: 'Giờ chuẩn', width: 14, format: '0.00', value: (row) => row.targetMinutes / 60 },
  { header: 'Đi trễ (phút)', width: 17, value: (row) => row.timesheet.late_minutes },
  { header: 'Về sớm (phút)', width: 17, value: (row) => row.timesheet.early_minutes },
  { header: 'Tăng ca (phút)', width: 17, value: (row) => row.overtimeMinutes },
  { header: 'Địa điểm', width: 18, value: (row) => row.timesheet.location_id || '' },
  { header: 'Ngoại lệ', width: 28, value: (row) => formatExceptions(row.timesheet.exception_codes) },
  { header: 'Trạng thái', width: 18, value: (row) => formatStatus(row.timesheet.status) },
  { header: 'Nguồn dữ liệu', width: 17, value: (row) => row.timesheet.source },
];

function attendanceRows(input: { timesheets: Timesheet[]; employees: Employee[]; policies: AttendancePolicy[] }) {
  const employees = new Map(input.employees.map((employee) => [employee.employee_id, employee]));
  const policies = new Map(input.policies.map((policy) => [policy.id, policy]));
  return input.timesheets.map((timesheet) => {
    const policy = timesheet.policy_id ? policies.get(timesheet.policy_id) : undefined;
    const targetMinutes = scheduledMinutes(timesheet, policy?.unpaid_break_minutes ?? 0);
    return {
      timesheet,
      employee: employees.get(timesheet.employee_id),
      targetMinutes,
      overtimeMinutes: Math.max(0, timesheet.work_minutes - targetMinutes),
    };
  });
}

export function exportAttendanceExcel(input: {
  month: string;
  timesheets: Timesheet[];
  employees: Employee[];
  policies: AttendancePolicy[];
}) {
  return exportExcel({
    filename: `bang-cong-${input.month}.xlsx`,
    sheetName: 'Bảng công',
    columns: ATTENDANCE_COLUMNS,
    rows: attendanceRows(input),
  });
}

interface PayrollExportRow {
  period: string;
  periodStatus: string;
  employeeId: string;
  employee?: Employee;
  workDays: number;
  workMinutes: number;
  lateMinutes: number;
  earlyMinutes: number;
  overtimeMinutes: number;
  exceptionDays: number;
  lockedDays: number;
}

const PAYROLL_COLUMNS: ExcelColumn<PayrollExportRow>[] = [
  { header: 'Kỳ lương', width: 14, value: (row) => row.period },
  { header: 'Trạng thái kỳ', width: 18, value: (row) => row.periodStatus },
  { header: 'Mã nhân viên', width: 16, value: (row) => row.employeeId },
  { header: 'Họ tên', width: 24, value: (row) => row.employee?.name || '' },
  { header: 'Phòng ban', width: 20, value: (row) => row.employee?.department || '' },
  { header: 'Chi nhánh', width: 16, value: (row) => row.employee?.center_id || '' },
  { header: 'Ngày có công', width: 16, format: '0.0', value: (row) => row.workDays },
  { header: 'Tổng giờ công', width: 18, format: '0.00', value: (row) => row.workMinutes / 60 },
  { header: 'Đi trễ (phút)', width: 17, value: (row) => row.lateMinutes },
  { header: 'Về sớm (phút)', width: 17, value: (row) => row.earlyMinutes },
  { header: 'Tăng ca (phút)', width: 17, value: (row) => row.overtimeMinutes },
  { header: 'Ngày ngoại lệ', width: 17, value: (row) => row.exceptionDays },
  { header: 'Ngày đã khóa', width: 17, value: (row) => row.lockedDays },
];

export function exportPayrollExcel(input: {
  month: string;
  timesheets: Timesheet[];
  employees: Employee[];
  policies: AttendancePolicy[];
  closed: boolean;
}) {
  const employees = new Map(input.employees.map((employee) => [employee.employee_id, employee]));
  const policies = new Map(input.policies.map((policy) => [policy.id, policy]));
  const totals = new Map<string, Omit<PayrollExportRow, 'period' | 'periodStatus' | 'employeeId' | 'employee'>>();
  const countedDays = new Set<string>();

  for (const timesheet of input.timesheets) {
    const current = totals.get(timesheet.employee_id) || {
      workDays: 0,
      workMinutes: 0,
      lateMinutes: 0,
      earlyMinutes: 0,
      overtimeMinutes: 0,
      exceptionDays: 0,
      lockedDays: 0,
    };
    const policy = timesheet.policy_id ? policies.get(timesheet.policy_id) : undefined;
    const targetMinutes = scheduledMinutes(timesheet, policy?.unpaid_break_minutes ?? 0);
    // Counted once per date, from the server's stored figure.
    //
    // This used to add one per row, and these rows are sessions: a day worked
    // as a morning and an afternoon shift — which the system records correctly
    // and people are told to do — was worth two ngày công here, in the file
    // that goes to payroll. It also had its own idea of what earns a day,
    // disagreeing with both screens; that rule now lives on the server.
    const dayKey = `${timesheet.employee_id}:${timesheet.work_date}`;
    if (!countedDays.has(dayKey)) {
      countedDays.add(dayKey);
      current.workDays += Number(timesheet.day_work_credit ?? 0);
    }
    current.workMinutes += timesheet.work_minutes || 0;
    current.lateMinutes += timesheet.late_minutes || 0;
    current.earlyMinutes += timesheet.early_minutes || 0;
    current.overtimeMinutes += Math.max(0, (timesheet.work_minutes || 0) - targetMinutes);
    if (timesheet.exception_codes.length || ['EXCEPTION', 'REJECTED', 'PENDING_REVIEW'].includes(timesheet.status)) current.exceptionDays += 1;
    if (timesheet.status === 'LOCKED') current.lockedDays += 1;
    totals.set(timesheet.employee_id, current);
  }

  const rows: PayrollExportRow[] = [...totals.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([employeeId, total]) => ({
      period: input.month,
      periodStatus: input.closed ? 'Đã đóng' : 'Bản nháp',
      employeeId,
      employee: employees.get(employeeId),
      ...total,
    }));
  return exportExcel({
    filename: `payroll-${input.month}${input.closed ? '-closed' : '-draft'}.xlsx`,
    sheetName: 'Payroll',
    columns: PAYROLL_COLUMNS,
    rows,
  });
}
