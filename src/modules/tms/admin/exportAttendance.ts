import { createExcelSheet, exportExcelWorkbook, type ExcelColumn } from '@/core/utils/excel';
import type { Employee } from '@/shared/types';
import { formatClock, formatExceptions, formatStatus } from './formatters';
import {
  buildAttendanceExportRows,
  summarizeAttendanceMonth,
  type AttendanceExportRow,
  type MonthlyAttendanceSummary,
} from './attendanceCalendar';
import type { AttendancePolicy, Timesheet } from './types';

interface AttendanceExportInput {
  month: string;
  timesheets: Timesheet[];
  employees: Employee[];
  policies: AttendancePolicy[];
}

const ATTENDANCE_COLUMNS: ExcelColumn<AttendanceExportRow>[] = [
  { header: 'Mã nhân viên', width: 16, value: (row) => row.employeeId },
  { header: 'Họ tên', width: 24, value: (row) => row.employee?.name || '' },
  { header: 'Phòng ban', width: 20, value: (row) => row.employee?.department || '' },
  { header: 'Chi nhánh', width: 16, value: (row) => row.employee?.center_id || '' },
  { header: 'Ngày công', width: 16, format: 'yyyy-mm-dd', value: (row) => new Date(`${row.workDate}T00:00:00`) },
  { header: 'Số công ngày', width: 17, format: '0.##', value: (row) => row.dayCredit === null ? 'Chưa xác định' : row.dayCredit },
  { header: 'Giờ dự kiến', width: 18, value: (row) => row.timesheet ? `${formatClock(row.timesheet.expected_start)}–${formatClock(row.timesheet.expected_end)}` : '' },
  { header: 'Check-in', width: 15, value: (row) => row.timesheet ? formatClock(row.timesheet.actual_checkin) : '' },
  { header: 'Check-out', width: 15, value: (row) => row.timesheet ? formatClock(row.timesheet.actual_checkout) : '' },
  { header: 'Giờ công', width: 14, format: '0.00', value: (row) => row.timesheet ? (row.timesheet.work_minutes || 0) / 60 : null },
  { header: 'Giờ chuẩn ca', width: 16, format: '0.00', value: (row) => row.timesheet ? (row.targetMinutes || 0) / 60 : null },
  { header: 'Đi trễ (phút)', width: 17, value: (row) => row.timesheet ? row.timesheet.late_minutes : null },
  { header: 'Về sớm (phút)', width: 17, value: (row) => row.timesheet ? row.timesheet.early_minutes : null },
  { header: 'Tăng ca (phút)', width: 17, value: (row) => row.timesheet ? row.overtimeMinutes : null },
  { header: 'Địa điểm', width: 18, value: (row) => row.timesheet?.location_id || '' },
  { header: 'Ngoại lệ', width: 28, value: (row) => row.timesheet ? formatExceptions(row.timesheet.exception_codes || []) : '' },
  { header: 'Trạng thái', width: 24, value: (row) => row.timesheet ? formatStatus(row.timesheet.status) : row.missingStatus || 'Chưa có dữ liệu' },
  { header: 'Nguồn dữ liệu', width: 17, value: (row) => row.timesheet?.source || '' },
];

function summaryStatus(row: MonthlyAttendanceSummary) {
  if (row.unknownCreditDays > 0) return 'Có ngày thiếu số công từ hệ thống';
  if (row.reviewDays > 0) return 'Có ngày công cần xử lý';
  if (row.missingDays > 0) return 'Có ngày chưa có bản ghi';
  if (row.futureDays > 0) return 'Tháng chưa kết thúc';
  return 'Đã tổng hợp theo dữ liệu ghi nhận';
}

const SUMMARY_COLUMNS: ExcelColumn<MonthlyAttendanceSummary>[] = [
  { header: 'Kỳ công', width: 14, value: (row) => row.month },
  { header: 'Mã nhân viên', width: 16, value: (row) => row.employeeId },
  { header: 'Họ tên', width: 24, value: (row) => row.employee?.name || '' },
  { header: 'Phòng ban', width: 20, value: (row) => row.employee?.department || '' },
  { header: 'Chi nhánh', width: 16, value: (row) => row.employee?.center_id || '' },
  { header: 'Số công ghi nhận', width: 19, format: '0.##', value: (row) => row.workDays },
  { header: 'Ngày có ca', width: 16, value: (row) => row.recordedDays },
  { header: 'Ngày chưa có bản ghi', width: 22, value: (row) => row.missingDays },
  { header: 'Ngày thiếu số công', width: 20, value: (row) => row.unknownCreditDays },
  { header: 'Ngày công cần xử lý', width: 20, value: (row) => row.reviewDays },
  { header: 'Ngày chưa đến', width: 18, value: (row) => row.futureDays },
  { header: 'Ngày ngoài thời gian làm', width: 23, value: (row) => row.outsideEmploymentDays },
  { header: 'Tổng giờ công', width: 18, format: '0.00', value: (row) => row.totalWorkMinutes / 60 },
  { header: 'Giờ chuẩn ca có dữ liệu', width: 25, format: '0.00', value: (row) => row.standardMinutes / 60 },
  { header: 'Đi trễ (phút)', width: 18, value: (row) => row.lateMinutes },
  { header: 'Về sớm (phút)', width: 18, value: (row) => row.earlyMinutes },
  { header: 'Tăng ca (giờ)', width: 18, format: '0.00', value: (row) => row.overtimeMinutes / 60 },
  { header: 'Ngày đã khóa', width: 17, value: (row) => row.lockedDays },
  { header: 'Tình trạng dữ liệu', width: 39, value: summaryStatus },
];

function calendarColumns(month: string): ExcelColumn<MonthlyAttendanceSummary>[] {
  const dayCount = Number(new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate());
  return [
    { header: 'Mã nhân viên', width: 17, value: (row) => row.employeeId },
    { header: 'Họ tên', width: 24, value: (row) => row.employee?.name || '' },
    { header: 'Chi nhánh', width: 16, value: (row) => row.employee?.center_id || '' },
    ...Array.from({ length: dayCount }, (_, index): ExcelColumn<MonthlyAttendanceSummary> => ({
      header: String(index + 1).padStart(2, '0'),
      width: 8,
      format: '0.##',
      align: 'center',
      value: (row) => row.dailyCredits[index] ?? '',
    })),
    { header: 'Tổng công', width: 16, format: '0.##', value: (row) => row.workDays },
    { header: 'Ngày thiếu số công', width: 20, value: (row) => row.unknownCreditDays },
    { header: 'Tổng giờ công', width: 18, format: '0.00', value: (row) => row.totalWorkMinutes / 60 },
    { header: 'Ghi chú', width: 39, value: summaryStatus },
  ];
}

/**
 * A complete HR attendance file: monthly totals, a day-by-day credit matrix,
 * and unmodified real session detail. All three tabs use the same source rows.
 */
export function exportAttendanceExcel(input: AttendanceExportInput) {
  const detail = buildAttendanceExportRows(input);
  const monthly = summarizeAttendanceMonth(input.month, detail);
  return exportExcelWorkbook({
    filename: `bang-cong-${input.month}.xlsx`,
    sheets: [
      createExcelSheet({ sheetName: 'Tổng hợp công', columns: SUMMARY_COLUMNS, rows: monthly }),
      createExcelSheet({ sheetName: 'Công theo ngày', columns: calendarColumns(input.month), rows: monthly }),
      createExcelSheet({ sheetName: 'Chi tiết ca', columns: ATTENDANCE_COLUMNS, rows: detail }),
    ],
  });
}

interface PayrollSummaryRow extends MonthlyAttendanceSummary {
  periodStatus: string;
}

const PAYROLL_COLUMNS: ExcelColumn<PayrollSummaryRow>[] = [
  { header: 'Kỳ lương', width: 14, value: (row) => row.month },
  { header: 'Trạng thái kỳ', width: 18, value: (row) => row.periodStatus },
  { header: 'Mã nhân viên', width: 16, value: (row) => row.employeeId },
  { header: 'Họ tên', width: 24, value: (row) => row.employee?.name || '' },
  { header: 'Phòng ban', width: 20, value: (row) => row.employee?.department || '' },
  { header: 'Chi nhánh', width: 16, value: (row) => row.employee?.center_id || '' },
  { header: 'Số ngày công ghi nhận', width: 22, format: '0.##', value: (row) => row.workDays },
  { header: 'Ngày thiếu số công', width: 20, value: (row) => row.unknownCreditDays },
  { header: 'Ngày chưa có bản ghi', width: 23, value: (row) => row.missingDays },
  { header: 'Tổng giờ công', width: 18, format: '0.00', value: (row) => row.totalWorkMinutes / 60 },
  { header: 'Đi trễ (phút)', width: 17, value: (row) => row.lateMinutes },
  { header: 'Về sớm (phút)', width: 17, value: (row) => row.earlyMinutes },
  { header: 'Tăng ca (phút)', width: 17, value: (row) => row.overtimeMinutes },
  { header: 'Ngày cần xử lý', width: 20, value: (row) => row.reviewDays },
  { header: 'Ngày đã khóa', width: 17, value: (row) => row.lockedDays },
  { header: 'Tình trạng dữ liệu', width: 39, value: summaryStatus },
];

export function exportPayrollExcel(input: AttendanceExportInput & { closed: boolean }) {
  const detail = buildAttendanceExportRows(input);
  const monthly = summarizeAttendanceMonth(input.month, detail);
  const payroll: PayrollSummaryRow[] = monthly.map((row) => ({
    ...row,
    periodStatus: input.closed ? 'Đã đóng' : 'Bản nháp',
  }));
  return exportExcelWorkbook({
    filename: `payroll-${input.month}${input.closed ? '-closed' : '-draft'}.xlsx`,
    sheets: [
      createExcelSheet({ sheetName: 'Payroll', columns: PAYROLL_COLUMNS, rows: payroll }),
      createExcelSheet({ sheetName: 'Công theo ngày', columns: calendarColumns(input.month), rows: monthly }),
      createExcelSheet({ sheetName: 'Chi tiết ca', columns: ATTENDANCE_COLUMNS, rows: detail }),
    ],
  });
}
