import { supabase, isSupabaseConfigured } from '@/core/supabase';
import { FunctionsHttpError } from '@supabase/supabase-js';
import { resetTrustedDeviceAsAdmin } from '@/core/deviceBinding';
import { TMS_DEFAULT_POLICY, TMS_DEFAULTS, TMS_LIMITS } from '@/shared/constants';
import type { Employee } from '@/shared/types';
import type {
  AdminData,
  AttendancePolicy,
  AttendanceRange,
  AttendanceRequest,
  AttendancePeriod,
  AuditLogInfo,
  HolidayRecord,
  QrStationInfo,
  ShiftRecord,
  ShiftAssignment,
  SystemSetting,
  Timesheet,
  TmsLocation,
  TrustedDeviceInfo,
} from './types';
import {
  clearWorkforceResourceCache,
  queryWorkforce,
  queryWorkforceRows,
  type WorkforceResource,
} from '@/modules/tms/services/workforceApi';

interface ServiceError { message?: string; }
type DataRow = Record<string, unknown>;

function fail(error: ServiceError | null, fallback: string): never {
  throw new Error(error?.message || fallback);
}

async function edgeFunctionError(error: unknown, fallback: string) {
  if (error instanceof FunctionsHttpError) {
    try {
      const payload = await error.context.json() as { error?: string };
      return new Error(payload.error || fallback);
    } catch {
      return new Error(fallback);
    }
  }
  return new Error(error instanceof Error && error.message ? error.message : fallback);
}

type EmployeeWriteOutcome = 'rejected' | 'partial' | 'unknown';

class EmployeeWriteError extends Error {
  readonly outcome: EmployeeWriteOutcome;
  readonly code?: string;
  readonly commitState?: string;

  constructor(
    message: string,
    outcome: EmployeeWriteOutcome,
    details: { code?: string; commitState?: string } = {},
  ) {
    super(message);
    this.name = 'EmployeeWriteError';
    this.outcome = outcome;
    this.code = details.code;
    this.commitState = details.commitState;
  }
}

async function employeeWriteError(error: unknown, fallback: string) {
  if (error instanceof FunctionsHttpError) {
    try {
      const payload = await error.context.json() as {
        error?: string;
        code?: string;
        commit_state?: string;
      };
      return new EmployeeWriteError(
        payload.error || fallback,
        payload.commit_state && payload.commit_state !== 'ROLLED_BACK' ? 'partial' : 'rejected',
        { code: payload.code, commitState: payload.commit_state },
      );
    } catch {
      return new EmployeeWriteError(fallback, 'unknown');
    }
  }
  // A fetch/relay failure can happen after the Edge Function committed. Do not
  // tell the operator the row failed; force a reload and reconcile by upsert.
  return new EmployeeWriteError(
    error instanceof Error && error.message ? error.message : fallback,
    'unknown',
  );
}

async function workforceCommand(action: string, args: Record<string, unknown>) {
  const { data, error } = await supabase.rpc('workforce_command', {
    p_action: action,
    p_args: args,
  });
  if (error) fail(error, 'Không thể hoàn tất thao tác Workforce.');
  if (!data || typeof data !== 'object' || (data as DataRow).ok !== true) {
    throw new Error(typeof (data as DataRow | null)?.message === 'string' ? String((data as DataRow).message) : 'Thao tác Workforce không thành công.');
  }
  clearWorkforceResourceCache();
  return data as DataRow;
}

let loadedConfigRevision = 0;

async function configPatch(operations: WorkforceResource[]) {
  if (!loadedConfigRevision) {
    const config = await queryWorkforce('admin.config', {}, { force: true });
    loadedConfigRevision = Number(config.config_revision || 0);
  }
  if (!Number.isSafeInteger(loadedConfigRevision) || loadedConfigRevision < 1) {
    throw new Error('Không đọc được phiên bản cấu hình hiện tại.');
  }
  const result = await workforceCommand('config.patch', {
    command_id: crypto.randomUUID(),
    expected_revision: loadedConfigRevision,
    operations,
  });
  loadedConfigRevision = Number(result.revision || 0);
  return result;
}

function mapEmployees(rows: Array<Record<string, unknown>>): Employee[] {
  return rows.map((row) => ({
    ...row,
    id: String(row.employee_id),
    uid: row.auth_user_id ? String(row.auth_user_id) : undefined,
    annual_leave_balance: Number(row.annual_leave_balance ?? TMS_DEFAULTS.ANNUAL_LEAVE_DAYS),
    allowed_locations: Array.isArray(row.allowed_locations) ? row.allowed_locations : [],
    managed_locations: Array.isArray(row.managed_locations) ? row.managed_locations : [],
  })) as Employee[];
}

function attachWorkDates(requests: AttendanceRequest[], timesheets: Timesheet[]) {
  const dates = new Map(timesheets.map((timesheet) => [timesheet.id, timesheet.work_date]));
  return requests.map((request) => ({
    ...request,
    work_date: request.work_date || (request.timesheet_id ? dates.get(request.timesheet_id) : undefined) || request.from_date,
    origin: 'timesheet' as const,
  }));
}

export async function getAdminData(range: AttendanceRange): Promise<AdminData> {
  if (!isSupabaseConfigured) throw new Error('Chưa cấu hình Supabase. Vui lòng kiểm tra biến môi trường.');
  const bootstrapData = await queryWorkforce('bootstrap', {}, { force: true });
  const profile = bootstrapData.profile && typeof bootstrapData.profile === 'object'
    ? bootstrapData.profile as DataRow
    : {};
  const scope = `${String(profile.organization_id || 'unassigned')}:${String(profile.employee_id || 'admin')}`;
  const [config, employeeRows, sessionRows, pendingRows, monthlyRows, deviceRows, auditRows, assignmentRows] = await Promise.all([
    queryWorkforce('admin.config', {}, { scope, ttlSeconds: TMS_LIMITS.RESOURCE_CACHE_MAX_SECONDS }),
    queryWorkforceRows('admin.people', {}, { scope }),
    queryWorkforceRows('admin.sessions', { from: range.from, to: range.to }, { scope }),
    queryWorkforceRows('admin.requests', { state: 'pending' }, { scope }),
    queryWorkforceRows('admin.requests', { from: range.from, to: range.to }, { scope }),
    queryWorkforceRows('admin.devices', {}, { scope }),
    queryWorkforceRows('admin.audit', {}, { scope, maxPages: Math.ceil(TMS_LIMITS.ADMIN_AUDIT_QUERY_LIMIT / TMS_LIMITS.RESOURCE_PAGE_SIZE) }),
    queryWorkforceRows('admin.schedule', { from: range.from, to: range.to }, { scope }),
  ]);
  const capabilities = Array.isArray(bootstrapData.capabilities)
    ? bootstrapData.capabilities.filter((item): item is string => typeof item === 'string')
    : [];
  const employees = mapEmployees(employeeRows).sort((a, b) => a.name.localeCompare(b.name, 'vi'));
  const timesheets = sessionRows.map((row) => ({
    ...row,
    work_date: String(row.business_date || row.work_date || ''),
    status: row.status === 'NEEDS_REVIEW' ? 'EXCEPTION' : row.status,
    source: row.source === 'IMPORT' ? 'LEGACY' : row.source,
  })) as unknown as Timesheet[];
  const requestTypeFilter = (row: WorkforceResource) => row.request_type === 'EXPLANATION' || row.request_type === 'CORRECTION';
  const pendingRequestsRaw = pendingRows.filter(requestTypeFilter) as unknown as AttendanceRequest[];
  const monthlyRequestsRaw = monthlyRows.filter(requestTypeFilter) as unknown as AttendanceRequest[];
  const requests = attachWorkDates(pendingRequestsRaw, timesheets);
  const monthlyRequests = attachWorkDates(monthlyRequestsRaw, timesheets);
  loadedConfigRevision = Number(config.config_revision || 1);
  return {
    configRevision: Number(config.config_revision || 1),
    capabilities,
    employees,
    locations: (Array.isArray(config.locations) ? config.locations : []) as TmsLocation[],
    policies: (Array.isArray(config.policies) ? config.policies : []) as AttendancePolicy[],
    timesheets,
    requests,
    monthlyRequests,
    stations: (Array.isArray(config.stations) ? config.stations : []) as QrStationInfo[],
    devices: deviceRows as unknown as TrustedDeviceInfo[],
    shifts: (Array.isArray(config.shifts) ? config.shifts : []) as ShiftRecord[],
    shiftAssignments: assignmentRows as unknown as ShiftAssignment[],
    attendancePeriods: (Array.isArray(config.attendancePeriods) ? config.attendancePeriods : []) as AttendancePeriod[],
    systemSettings: (Array.isArray(config.systemSettings) ? config.systemSettings : []) as SystemSetting[],
    holidays: (Array.isArray(config.holidays) ? config.holidays : []) as HolidayRecord[],
    auditLogs: auditRows.slice(0, TMS_LIMITS.ADMIN_AUDIT_QUERY_LIMIT) as unknown as AuditLogInfo[],
    features: { workforceOperations: true },
  };
}

export async function reviewAttendanceRequest(request: AttendanceRequest, status: 'APPROVED' | 'REJECTED', note = '') {
  if (!isSupabaseConfigured) return { id: request.id, status, note };
  if (status === 'REJECTED' && note.trim().length < 5) throw new Error('Từ chối yêu cầu cần ghi chú ít nhất 5 ký tự.');
  return workforceCommand('request.review', {
    id: request.id,
    revision: Number(request.revision || 0),
    decision: status,
    note: note.trim(),
  });
}

export async function reviewAttendanceRequestsBulk(requests: AttendanceRequest[], status: 'APPROVED' | 'REJECTED', note = '') {
  if (!requests.length) return 0;
  if (!isSupabaseConfigured) return requests.length;
  if (status === 'REJECTED' && note.trim().length < 5) throw new Error('Từ chối hàng loạt cần ghi chú ít nhất 5 ký tự.');
  const result = await workforceCommand('request.review_many', {
    requests: requests.map((request) => ({ id: request.id, revision: Number(request.revision || 0) })),
    decision: status,
    note: note.trim(),
  });
  return Number(result.count || requests.length);
}

export async function saveShiftAssignments(assignments: Array<{
  employee_id: string;
  work_date: string;
  shift_id: number;
  location_id?: string | null;
  note?: string;
  revision?: number;
}>) {
  if (!assignments.length) return 0;
  const dates = assignments.map((assignment) => assignment.work_date).sort();
  const existing = await queryWorkforceRows('admin.schedule', {
    from: dates[0] || '',
    to: dates[dates.length - 1] || '',
  }, { maxPages: TMS_LIMITS.RESOURCE_MAX_PAGES });
  const existingMap = new Map(existing.map((item) => [`${String(item.employee_id)}:${String(item.work_date)}`, item]));
  const editingPublished = existing.some((item) => item.publication_status === 'PUBLISHED');
  const result = await workforceCommand('schedule.save', {
    assignments: assignments.map((assignment) => {
      const current = existingMap.get(`${assignment.employee_id}:${assignment.work_date}`);
      return {
        ...assignment,
        assignment_id: current?.id,
        revision: current?.revision ?? assignment.revision,
      };
    }),
    override_reason: editingPublished ? 'Điều chỉnh lịch từ Control Center' : '',
  });
  return Number(result.count || assignments.length);
}

export async function publishShiftAssignments(range: AttendanceRange) {
  const result = await workforceCommand('schedule.publish', { from: range.from, to: range.to });
  return Number(result.count || 0);
}

export async function deleteShiftAssignment(id: string, _reason = '') {
  const detail = await queryWorkforce('assignment.detail', { id }, { force: true });
  const assignment = detail.row && typeof detail.row === 'object' ? detail.row as DataRow : null;
  if (!assignment) throw new Error('Lịch phân ca không còn tồn tại.');
  if (assignment.publication_status === 'PUBLISHED') throw new Error('Lịch đã công bố. Hãy điều chỉnh lịch thay vì xóa trực tiếp.');
  await workforceCommand('schedule.delete', { id, revision: Number(assignment.revision || 0) });
}

export async function closeAttendancePeriod(range: AttendanceRange, note = '') {
  if (note.trim().length < 5) throw new Error('Ghi chú đóng kỳ cần ít nhất 5 ký tự.');
  const result = await workforceCommand('payroll.close', {
    from: range.from,
    to: range.to,
    note: note.trim(),
  });
  return { locked_count: Number(result.count || 0) };
}

export async function saveAttendancePolicy(policy: AttendancePolicy) {
  const payload = {
    ...(policy.id ? { id: policy.id } : {}),
    name: policy.name.trim(),
    work_days: policy.work_days,
    expected_start: policy.expected_start || TMS_DEFAULT_POLICY.EXPECTED_START,
    expected_end: policy.expected_end || TMS_DEFAULT_POLICY.EXPECTED_END,
    late_tolerance_minutes: Number(policy.late_tolerance_minutes),
    early_tolerance_minutes: Number(policy.early_tolerance_minutes),
    checkin_window_start: policy.checkin_window_start,
    checkin_window_end: policy.checkin_window_end,
    checkout_window_start: policy.checkout_window_start,
    checkout_window_end: policy.checkout_window_end,
    gps_good_accuracy_m: Number(policy.gps_good_accuracy_m),
    gps_max_accuracy_m: Number(policy.gps_max_accuracy_m),
    unpaid_break_minutes: Number(policy.unpaid_break_minutes),
    auto_approve: policy.auto_approve,
    active: policy.active,
  };
  await configPatch([{ resource: 'policy', op: 'upsert', ...payload }]);
}

export async function saveTmsLocation(location: TmsLocation) {
  await configPatch([{ resource: 'location', op: 'upsert',
    center_id: location.center_id.trim().toUpperCase(),
    center_name: location.center_name.trim(),
    address: location.address?.trim() || null,
    city: location.city?.trim() || null,
    latitude: Number(location.latitude),
    longitude: Number(location.longitude),
    radius_meters: Number(location.radius_meters),
    active: location.active,
  }]);
}

export interface EmployeeInput {
  employee_id: string;
  name: string;
  email: string;
  phone?: string;
  role: Employee['role'];
  center_id: string;
  allowed_locations?: string[];
  managed_locations?: string[];
  direct_manager_id?: string | null;
  annual_leave_balance?: number;
  attendance_policy_id?: string | null;
  position?: string;
  department?: string;
  status: Employee['status'];
  /** Device lock override: true/false force it, null follows the role policy. */
  device_lock_required?: boolean | null;
  password?: string;
  reset_trusted_device?: boolean;
  reset_device_reason?: string;
}

export async function saveEmployee(
  employee: EmployeeInput,
  mode: 'create' | 'update' | 'upsert',
  options: { expectedMode?: 'create' | 'update' } = {},
) {
  const { data, error } = await supabase.functions.invoke('admin-users', {
    body: { action: mode, expected_action: options.expectedMode, employee },
  });
  if (error) throw await employeeWriteError(error, 'Không thể lưu tài khoản nhân viên.');
  if (!data?.ok) {
    const commitState = typeof data?.commit_state === 'string' ? data.commit_state : undefined;
    throw new EmployeeWriteError(
      data?.error || 'Không thể lưu nhân viên.',
      commitState && commitState !== 'ROLLED_BACK' ? 'partial' : 'rejected',
      { code: typeof data?.code === 'string' ? data.code : undefined, commitState },
    );
  }
  return data;
}

export async function deleteEmployeeAccount(employeeId: string) {
  const { data, error } = await supabase.functions.invoke('admin-users', { body: { action: 'delete', employee: { employee_id: employeeId } } });
  if (error) throw await edgeFunctionError(error, 'Không thể xóa tài khoản đăng nhập.');
  if (!data?.ok) throw new Error(data?.error || 'Không thể xóa tài khoản đăng nhập.');
  return data;
}

export async function resetEmployeeDevice(employeeId: string, reason: string) {
  return resetTrustedDeviceAsAdmin(employeeId, reason);
}

export async function saveShift(shift: ShiftRecord) {
  const payload = {
    ...(shift.id ? { id: shift.id } : {}),
    name: shift.name.trim(),
    start_time: shift.start_time,
    end_time: shift.end_time,
    break_point: shift.break_point,
    sort_order: Number(shift.sort_order),
    active: shift.active,
  };
  await configPatch([{ resource: 'shift', op: 'upsert', ...payload }]);
}

export async function saveSystemSettings(settings: SystemSetting[]) {
  await configPatch(settings.map((setting) => ({
    resource: 'system',
    op: 'upsert',
    key: setting.key,
    value: setting.value,
  })));
}

export async function saveHoliday(holiday: HolidayRecord) {
  const payload = {
    ...(holiday.id ? { id: holiday.id } : {}),
    name: holiday.name.trim(),
    from_date: holiday.from_date,
    to_date: holiday.to_date,
    paid: holiday.paid,
    active: holiday.active,
  };
  await configPatch([{ resource: 'holiday', op: 'upsert', ...payload }]);
}

export async function saveQrStation(station: QrStationInfo) {
  await configPatch([{
    resource: 'station',
    op: 'upsert',
    id: station.id,
    name: station.name.trim(),
    center_id: station.center_id,
    active: station.active,
  }]);
}
