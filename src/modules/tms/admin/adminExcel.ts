import { EMPLOYEE_ROLES, MANAGEMENT_ROLES, TMS_LIMITS } from '@/shared/constants';
import type { Employee, EmployeeRole } from '@/shared/types';
import {
  excelBoolean,
  excelDate,
  excelList,
  excelNumber,
  excelText,
  exportExcel,
  readExcelRows,
  type ExcelColumn,
} from '@/core/utils/excel';
import { defaultAccountPassword } from '@/core/utils/defaultPassword';
import type { EmployeeInput } from './adminService';
import type { AdminData, ShiftAssignment } from './types';

const EMPLOYEE_COLUMNS: ExcelColumn<Employee>[] = [
  { header: 'Mã nhân viên', width: 16, value: (item) => item.employee_id },
  { header: 'Họ tên', width: 24, value: (item) => item.name },
  { header: 'Email', width: 30, value: (item) => item.email },
  { header: 'Số điện thoại', width: 18, value: (item) => String(item.phone || '') },
  { header: 'Vai trò', width: 14, value: (item) => item.role },
  { header: 'Địa điểm chính', width: 18, value: (item) => item.center_id },
  { header: 'Địa điểm được phép', width: 28, value: (item) => (item.allowed_locations || []).join(', ') },
  { header: 'Địa điểm quản lý', width: 28, value: (item) => (item.managed_locations || []).join(', ') },
  { header: 'Mã quản lý', width: 16, value: (item) => item.direct_manager_id || '' },
  { header: 'Số ngày phép', width: 16, format: '0.0', value: (item) => item.annual_leave_balance ?? 0 },
  { header: 'Mã chính sách', width: 20, value: (item) => item.attendance_policy_id || '' },
  { header: 'Chức danh', width: 22, value: (item) => item.position || '' },
  { header: 'Phòng ban', width: 22, value: (item) => item.department || '' },
  { header: 'Trạng thái', width: 18, value: (item) => item.status === 'Active' ? 'Hoạt động' : 'Tạm khóa' },
  { header: 'Mật khẩu tạm (bỏ trống = mặc định)', width: 34, value: () => '' },
];

export function exportEmployeesExcel(employees: Employee[]) {
  return exportExcel({
    filename: `danh-sach-nhan-su-${new Date().toISOString().slice(0, 10)}.xlsx`,
    sheetName: 'Nhân sự',
    columns: EMPLOYEE_COLUMNS,
    rows: employees,
  });
}

export interface EmployeeImportRow {
  mode: 'create' | 'update';
  rowNumber: number;
  employee: EmployeeInput;
}

export interface EmployeeImportResult {
  total: number;
  confirmed: number;
  employeeIds: string[];
}

export type EmployeeImportFailureState = 'rejected' | 'partial' | 'unknown';

export class EmployeeImportError extends Error {
  readonly total: number;
  readonly confirmed: number;
  readonly failedRowNumber: number;
  readonly failedEmployeeId: string;
  readonly remaining: number;
  readonly failureState: EmployeeImportFailureState;
  readonly originalCause: unknown;

  constructor({
    cause,
    total,
    confirmed,
    failedRowNumber,
    failedEmployeeId,
    failureState,
  }: {
    cause: unknown;
    total: number;
    confirmed: number;
    failedRowNumber: number;
    failedEmployeeId: string;
    failureState: EmployeeImportFailureState;
  }) {
    const causeMessage = cause instanceof Error ? cause.message : 'Không thể đồng bộ dòng này.';
    const stateMessage = failureState === 'unknown'
      ? 'Kết quả dòng này chưa xác định do mất kết nối.'
      : failureState === 'partial'
        ? 'Máy chủ báo thao tác có thể mới hoàn tất một phần.'
        : 'Máy chủ từ chối dòng này.';
    const remaining = total - confirmed;
    super(
      `Đã xác nhận ${confirmed}/${total} dòng. Dừng tại dòng ${failedRowNumber} (${failedEmployeeId}). `
      + `${stateMessage} ${remaining} dòng chưa được xác nhận. ${causeMessage} `
      + 'Danh sách sẽ được tải lại; nhập lại cùng file để đối soát và tiếp tục.',
    );
    this.name = 'EmployeeImportError';
    this.total = total;
    this.confirmed = confirmed;
    this.failedRowNumber = failedRowNumber;
    this.failedEmployeeId = failedEmployeeId;
    this.remaining = remaining;
    this.failureState = failureState;
    this.originalCause = cause;
  }
}

function employeeImportFailureState(error: unknown): EmployeeImportFailureState {
  if (!error || typeof error !== 'object') return 'unknown';
  const outcome = Reflect.get(error, 'outcome');
  return outcome === 'rejected' || outcome === 'partial' || outcome === 'unknown'
    ? outcome
    : 'unknown';
}

export function assertEmployeeImportRowCount(rowCount: number) {
  if (rowCount < 1 || rowCount > TMS_LIMITS.MAX_EMPLOYEE_IMPORT_ROWS) {
    throw new Error(`File Excel phải có từ 1 đến ${TMS_LIMITS.MAX_EMPLOYEE_IMPORT_ROWS} nhân sự.`);
  }
}

/**
 * Runs a bounded, fail-fast import and records only server-confirmed rows.
 * `upsert` makes a retry reconcile rows already committed by an earlier attempt
 * instead of stopping at the first "employee already exists" response.
 */
export async function executeEmployeeImport(
  rows: EmployeeImportRow[],
  writeEmployee: (
    employee: EmployeeInput,
    mode: 'upsert',
    options: { expectedMode: 'create' | 'update' },
  ) => Promise<unknown>,
): Promise<EmployeeImportResult> {
  const employeeIds: string[] = [];
  for (const row of rows) {
    try {
      await writeEmployee(row.employee, 'upsert', { expectedMode: row.mode });
      employeeIds.push(row.employee.employee_id);
    } catch (error) {
      throw new EmployeeImportError({
        cause: error,
        total: rows.length,
        confirmed: employeeIds.length,
        failedRowNumber: row.rowNumber,
        failedEmployeeId: row.employee.employee_id,
        failureState: employeeImportFailureState(error),
      });
    }
  }
  return { total: rows.length, confirmed: employeeIds.length, employeeIds };
}

export async function parseEmployeesExcel(file: File, data: AdminData) {
  const rows = await readExcelRows(file);
  assertEmployeeImportRowCount(rows.length);
  const employeeIds = new Set(data.employees.map((item) => item.employee_id));
  const locationIds = new Set(data.locations.map((item) => item.center_id));
  const activePolicyIds = new Set(data.policies.filter((item) => item.active).map((item) => item.id));
  const soleActivePolicyId: string | null = activePolicyIds.size === 1
    ? activePolicyIds.values().next().value ?? null
    : null;
  const employeeByEmail = new Map(
    data.employees.map((item) => [item.email.trim().toLocaleLowerCase(), item.employee_id]),
  );
  const managerIds = new Set(data.employees.filter((item) => item.status === 'Active' && MANAGEMENT_ROLES.includes(item.role)).map((item) => item.employee_id));
  const errors: string[] = [];
  const seen = new Set<string>();
  const seenEmails = new Set<string>();
  const result: EmployeeImportRow[] = [];

  for (const row of rows) {
    const employeeId = excelText(row, 'Mã nhân viên').toUpperCase();
    const name = excelText(row, 'Họ tên');
    const email = excelText(row, 'Email').toLocaleLowerCase();
    const role = excelText(row, 'Vai trò') as EmployeeRole;
    const centerId = excelText(row, 'Địa điểm chính').toUpperCase();
    // Older exports carry the previous header, so both spellings stay readable.
    const suppliedPassword = excelText(row, 'Mật khẩu tạm (bỏ trống = mặc định)', 'Mật khẩu tạm (chỉ tài khoản mới)', 'Mật khẩu tạm');
    const mode = employeeIds.has(employeeId) ? 'update' : 'create';
    // A new account left blank is provisioned with the name-derived default;
    // an existing one keeps its password unless the operator typed a new value.
    const password = mode === 'create' && !suppliedPassword
      ? defaultAccountPassword({ name, employeeId })
      : suppliedPassword;
    const allowedLocations = excelList(row, 'Địa điểm được phép').map((item) => item.toUpperCase());
    const managedLocations = excelList(row, 'Địa điểm quản lý').map((item) => item.toUpperCase());
    const annualLeave = excelNumber(row, 0, 'Số ngày phép');
    const suppliedPolicyId = excelText(row, 'Mã chính sách');
    const policyId = role === 'Kiosk' ? null : suppliedPolicyId || soleActivePolicyId;
    const managerId = excelText(row, 'Mã quản lý').toUpperCase();
    const emailOwner = employeeByEmail.get(email);

    if (!employeeId || !name || !email || !role || !centerId) errors.push(`Dòng ${row.rowNumber}: thiếu trường bắt buộc.`);
    else if (seen.has(employeeId)) errors.push(`Dòng ${row.rowNumber}: mã nhân viên ${employeeId} bị trùng.`);
    else if (!EMPLOYEE_ROLES.includes(role)) errors.push(`Dòng ${row.rowNumber}: vai trò ${role} không hợp lệ.`);
    else if (!locationIds.has(centerId)) errors.push(`Dòng ${row.rowNumber}: địa điểm ${centerId} không tồn tại.`);
    else if ([...allowedLocations, ...managedLocations].some((id) => !locationIds.has(id))) errors.push(`Dòng ${row.rowNumber}: danh sách địa điểm có mã không tồn tại.`);
    else if (seenEmails.has(email)) errors.push(`Dòng ${row.rowNumber}: email ${email} bị trùng trong file.`);
    else if (emailOwner && emailOwner !== employeeId) errors.push(`Dòng ${row.rowNumber}: email ${email} đang thuộc nhân viên ${emailOwner}.`);
    else if (role !== 'Kiosk' && !policyId) errors.push(`Dòng ${row.rowNumber}: cần chọn chính sách chấm công đang hoạt động.`);
    else if (role !== 'Kiosk' && policyId && !activePolicyIds.has(policyId)) errors.push(`Dòng ${row.rowNumber}: chính sách ${policyId} không tồn tại hoặc đã tắt.`);
    else if (managerId && !managerIds.has(managerId)) errors.push(`Dòng ${row.rowNumber}: quản lý ${managerId} không tồn tại hoặc không hoạt động.`);
    else if (!Number.isFinite(annualLeave) || annualLeave < 0 || annualLeave > TMS_LIMITS.MAX_ANNUAL_LEAVE_DAYS) errors.push(`Dòng ${row.rowNumber}: số ngày phép không hợp lệ.`);
    else if (mode === 'create' && password.length < TMS_LIMITS.ACCOUNT_PASSWORD_MIN_LENGTH) errors.push(`Dòng ${row.rowNumber}: mật khẩu mặc định theo họ tên ngắn hơn ${TMS_LIMITS.ACCOUNT_PASSWORD_MIN_LENGTH} ký tự, hãy nhập mật khẩu tạm cho dòng này.`);
    else if (mode === 'update' && suppliedPassword && suppliedPassword.length < TMS_LIMITS.ACCOUNT_PASSWORD_MIN_LENGTH) errors.push(`Dòng ${row.rowNumber}: mật khẩu mới phải có ít nhất ${TMS_LIMITS.ACCOUNT_PASSWORD_MIN_LENGTH} ký tự.`);
    else if (!/^\S+@\S+\.\S+$/.test(email)) errors.push(`Dòng ${row.rowNumber}: email không hợp lệ.`);

    seen.add(employeeId);
    seenEmails.add(email);
    result.push({
      mode,
      rowNumber: row.rowNumber,
      employee: {
        employee_id: employeeId,
        name,
        email,
        phone: excelText(row, 'Số điện thoại'),
        role,
        center_id: centerId,
        allowed_locations: allowedLocations,
        managed_locations: managedLocations,
        direct_manager_id: managerId || null,
        annual_leave_balance: annualLeave,
        attendance_policy_id: policyId,
        position: excelText(row, 'Chức danh'),
        department: excelText(row, 'Phòng ban'),
        status: excelBoolean(row, true, 'Trạng thái') ? 'Active' : 'Inactive',
        password,
      },
    });
  }

  if (errors.length) {
    const remainder = errors.length > 6 ? ` và ${errors.length - 6} lỗi khác` : '';
    throw new Error(`${errors.slice(0, 6).join(' ')}${remainder}.`);
  }
  return result;
}

interface AssignmentExportRow {
  assignment: ShiftAssignment;
  employeeName: string;
  shiftName: string;
}

const ASSIGNMENT_COLUMNS: ExcelColumn<AssignmentExportRow>[] = [
  { header: 'Mã nhân viên', width: 16, value: (row) => row.assignment.employee_id },
  { header: 'Họ tên', width: 24, value: (row) => row.employeeName },
  { header: 'Ngày làm việc', width: 18, format: 'yyyy-mm-dd', value: (row) => new Date(`${row.assignment.work_date}T00:00:00`) },
  { header: 'Mã ca', width: 12, value: (row) => row.assignment.shift_id },
  { header: 'Tên ca', width: 20, value: (row) => row.shiftName },
  { header: 'Mã địa điểm', width: 18, value: (row) => row.assignment.location_id || '' },
  { header: 'Ghi chú', width: 34, value: (row) => row.assignment.note || '' },
];

export function exportShiftAssignmentsExcel(data: AdminData, month: string) {
  const employees = new Map(data.employees.map((item) => [item.employee_id, item.name]));
  const shifts = new Map(data.shifts.map((item) => [item.id, item.name]));
  const rows = data.shiftAssignments
    .filter((item) => item.work_date.startsWith(month))
    .map((assignment) => ({
      assignment,
      employeeName: employees.get(assignment.employee_id) || '',
      shiftName: shifts.get(assignment.shift_id) || '',
    }));
  return exportExcel({ filename: `phan-ca-${month}.xlsx`, sheetName: 'Phân ca', columns: ASSIGNMENT_COLUMNS, rows });
}

export async function parseShiftAssignmentsExcel(file: File, data: AdminData, month: string) {
  const rows = await readExcelRows(file);
  const employeeIds = new Set(data.employees.filter((item) => item.status === 'Active' && item.role !== 'Kiosk').map((item) => item.employee_id));
  const shiftsById = new Map(data.shifts.filter((item) => item.active).map((item) => [item.id, item]));
  const shiftsByName = new Map(data.shifts.filter((item) => item.active).map((item) => [item.name.toLocaleLowerCase('vi'), item]));
  const locationIds = new Set(data.locations.filter((item) => item.active).map((item) => item.center_id));
  const errors: string[] = [];
  const seen = new Set<string>();
  const assignments = rows.map((row) => {
    const employeeId = excelText(row, 'Mã nhân viên').toUpperCase();
    const workDate = excelDate(row, 'Ngày làm việc', 'Ngày');
    const shiftIdValue = excelNumber(row, 0, 'Mã ca');
    const shiftName = excelText(row, 'Tên ca').toLocaleLowerCase('vi');
    const shift = shiftsById.get(shiftIdValue) || shiftsByName.get(shiftName);
    const locationId = excelText(row, 'Mã địa điểm', 'Địa điểm').toUpperCase();
    const key = `${employeeId}:${workDate}`;

    if (!employeeIds.has(employeeId)) errors.push(`Dòng ${row.rowNumber}: nhân viên ${employeeId || '(trống)'} không hoạt động hoặc không tồn tại.`);
    else if (!workDate || !workDate.startsWith(month)) errors.push(`Dòng ${row.rowNumber}: ngày làm việc phải thuộc tháng ${month}.`);
    else if (!shift) errors.push(`Dòng ${row.rowNumber}: ca làm không tồn tại hoặc đã tắt.`);
    else if (locationId && !locationIds.has(locationId)) errors.push(`Dòng ${row.rowNumber}: địa điểm ${locationId} không tồn tại hoặc đã tắt.`);
    else if (seen.has(key)) errors.push(`Dòng ${row.rowNumber}: lịch ${key} bị trùng.`);
    seen.add(key);

    return {
      employee_id: employeeId,
      work_date: workDate,
      shift_id: shift?.id || 0,
      location_id: locationId || null,
      note: excelText(row, 'Ghi chú').slice(0, 500),
    };
  });

  if (errors.length) {
    const remainder = errors.length > 6 ? ` và ${errors.length - 6} lỗi khác` : '';
    throw new Error(`${errors.slice(0, 6).join(' ')}${remainder}.`);
  }
  if (!assignments.length || assignments.length > TMS_LIMITS.MAX_SPREADSHEET_IMPORT_ROWS) {
    throw new Error('File Excel không có lịch phân ca hợp lệ.');
  }
  return assignments;
}
