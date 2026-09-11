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

async function workforceCommand(action: string, args: Record<string, unknown>) {
  const { data, error } = await supabase.rpc('workforce_command', {
    p_action: action,
    p_args: args,
  });
  if (error) fail(error, 'Không thể hoàn tất thao tác Workforce.');
  if (!data || typeof data !== 'object' || (data as DataRow).ok !== true) {
    throw new Error(typeof (data as DataRow | null)?.message === 'string' ? String((data as DataRow).message) : 'Thao tác Workforce không thành công.');
  }
  return data as DataRow;
}

function isMissingWorkforceSchema(error: { code?: string; message?: string } | null) {
  return error?.code === '42P01'
    || error?.code === 'PGRST205'
    || Boolean(error?.message?.includes('shift_assignments'))
    || Boolean(error?.message?.includes('attendance_periods'));
}

async function getWorkforceOperations(range: AttendanceRange): Promise<{
  shiftAssignments: ShiftAssignment[];
  attendancePeriods: AttendancePeriod[];
  available: boolean;
}> {
  const [assignments, periods] = await Promise.all([
    supabase
      .from('shift_assignments')
      .select('*')
      .gte('work_date', range.from)
      .lte('work_date', range.to)
      .order('work_date')
      .order('employee_id'),
    supabase
      .from('attendance_periods')
      .select('*')
      .lte('period_start', range.to)
      .gte('period_end', range.from)
      .order('period_start', { ascending: false }),
  ]);
  if (assignments.error || periods.error) {
    const error = assignments.error || periods.error;
    if (isMissingWorkforceSchema(error)) return { shiftAssignments: [], attendancePeriods: [], available: false };
    fail(error, 'Không tải được dữ liệu phân ca và kỳ công.');
  }
  return {
    shiftAssignments: (assignments.data || []) as ShiftAssignment[],
    attendancePeriods: (periods.data || []) as AttendancePeriod[],
    available: true,
  };
}

async function getTimesheets(range: AttendanceRange): Promise<Timesheet[]> {
  const rows: Timesheet[] = [];
  let cursorDate = '';
  let cursorId = '';
  while (true) {
    let query = supabase
      .from('timesheets')
      .select('*')
      .gte('work_date', range.from)
      .lte('work_date', range.to)
      .order('work_date', { ascending: false })
      .order('id')
      .limit(TMS_LIMITS.ADMIN_FETCH_BATCH_SIZE);
    if (cursorDate && cursorId) query = query.or(`work_date.lt.${cursorDate},and(work_date.eq.${cursorDate},id.gt.${cursorId})`);
    const { data, error } = await query;
    if (error) fail(error, 'Không tải được bảng công.');
    const page = (data || []) as Timesheet[];
    rows.push(...page);
    if (page.length < TMS_LIMITS.ADMIN_FETCH_BATCH_SIZE) break;
    cursorDate = page[page.length - 1]?.work_date || '';
    cursorId = page[page.length - 1]?.id || '';
    if (!cursorDate || !cursorId) break;
  }
  return rows.sort((a, b) => b.work_date.localeCompare(a.work_date) || a.employee_id.localeCompare(b.employee_id));
}

async function getPendingRequests(): Promise<AttendanceRequest[]> {
  const rows: AttendanceRequest[] = [];
  let cursor = '';
  while (true) {
    let query = supabase
      .from('attendance_requests')
      .select('*')
      .eq('status', 'PENDING')
      .in('request_type', ['EXPLANATION', 'CORRECTION'])
      .order('id')
      .limit(TMS_LIMITS.ADMIN_FETCH_BATCH_SIZE);
    if (cursor) query = query.gt('id', cursor);
    const { data, error } = await query;
    if (error) fail(error, 'Không tải được yêu cầu chờ duyệt.');
    const page = (data || []) as AttendanceRequest[];
    rows.push(...page);
    if (page.length < TMS_LIMITS.ADMIN_FETCH_BATCH_SIZE) break;
    cursor = page[page.length - 1]?.id || '';
    if (!cursor) break;
  }
  return rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

async function getMonthlyRequests(range: AttendanceRange): Promise<AttendanceRequest[]> {
  const rows: AttendanceRequest[] = [];
  let cursor = '';
  while (true) {
    let query = supabase
      .from('attendance_requests')
      .select('*')
      .in('request_type', ['EXPLANATION', 'CORRECTION'])
      .lte('from_date', range.to)
      .gte('to_date', range.from)
      .order('id')
      .limit(TMS_LIMITS.ADMIN_FETCH_BATCH_SIZE);
    if (cursor) query = query.gt('id', cursor);
    const { data, error } = await query;
    if (error) fail(error, 'Không tải được yêu cầu trong kỳ.');
    const page = (data || []) as AttendanceRequest[];
    rows.push(...page);
    if (page.length < TMS_LIMITS.ADMIN_FETCH_BATCH_SIZE) break;
    cursor = page[page.length - 1]?.id || '';
    if (!cursor) break;
  }
  return rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
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

async function getEmployees(): Promise<Employee[]> {
  const rows: Array<Record<string, unknown>> = [];
  let cursor = '';
  while (true) {
    let query = supabase.from('employees').select('*').order('employee_id').limit(TMS_LIMITS.ADMIN_FETCH_BATCH_SIZE);
    if (cursor) query = query.gt('employee_id', cursor);
    const { data, error } = await query;
    if (error) fail(error, 'Không tải được danh sách nhân viên.');
    const page = (data || []) as Array<Record<string, unknown>>;
    rows.push(...page);
    if (page.length < TMS_LIMITS.ADMIN_FETCH_BATCH_SIZE) break;
    cursor = String(page[page.length - 1]?.employee_id || '');
    if (!cursor) break;
  }
  return mapEmployees(rows).sort((a, b) => a.name.localeCompare(b.name, 'vi'));
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
  const [employees, locations, policies, stations, devices, shifts, systemSettings, holidays, auditLogs, timesheets, pendingRequestsRaw, monthlyRequestsRaw, workforce] = await Promise.all([
    getEmployees(),
    supabase.from('locations').select('*').order('center_name'),
    supabase.from('attendance_policies').select('*').order('name'),
    supabase.from('qr_stations').select('*').order('updated_at', { ascending: false }),
    supabase.from('trusted_devices').select('device_id,employee_id,device_label,user_agent,status,activated_at,last_seen_at,organization_id').order('activated_at', { ascending: false }),
    supabase.from('config_shifts').select('*').order('sort_order'),
    supabase.from('config_system').select('key,value,updated_at').order('key'),
    supabase.from('holidays').select('*').order('from_date', { ascending: false }),
    supabase.from('audit_logs').select('*').order('created_at', { ascending: false }).limit(TMS_LIMITS.ADMIN_AUDIT_QUERY_LIMIT),
    getTimesheets(range),
    getPendingRequests(),
    getMonthlyRequests(range),
    getWorkforceOperations(range),
  ]);
  for (const result of [locations, policies, stations, devices, shifts, systemSettings, holidays, auditLogs]) {
    if (result.error) fail(result.error, 'Không tải được dữ liệu quản trị.');
  }

  const requests = attachWorkDates(pendingRequestsRaw, timesheets);
  const monthlyRequests = attachWorkDates(monthlyRequestsRaw, timesheets);
  return {
    employees,
    locations: (locations.data || []) as TmsLocation[],
    policies: (policies.data || []) as AttendancePolicy[],
    timesheets,
    requests,
    monthlyRequests,
    stations: (stations.data || []) as QrStationInfo[],
    devices: (devices.data || []) as TrustedDeviceInfo[],
    shifts: (shifts.data || []) as ShiftRecord[],
    shiftAssignments: workforce.shiftAssignments,
    attendancePeriods: workforce.attendancePeriods,
    systemSettings: (systemSettings.data || []) as SystemSetting[],
    holidays: (holidays.data || []) as HolidayRecord[],
    auditLogs: (auditLogs.data || []) as AuditLogInfo[],
    features: { workforceOperations: workforce.available },
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
  const employeeIds = [...new Set(assignments.map((assignment) => assignment.employee_id))];
  const dates = assignments.map((assignment) => assignment.work_date).sort();
  const { data: existing, error } = await supabase
    .from('shift_assignments')
    .select('employee_id,work_date,revision,publication_status')
    .in('employee_id', employeeIds)
    .gte('work_date', dates[0] || '')
    .lte('work_date', dates[dates.length - 1] || '');
  if (error) fail(error, 'Không kiểm tra được phiên bản lịch hiện tại.');
  const existingMap = new Map((existing || []).map((item) => [`${item.employee_id}:${item.work_date}`, item]));
  const editingPublished = (existing || []).some((item) => item.publication_status === 'PUBLISHED');
  const result = await workforceCommand('schedule.save', {
    assignments: assignments.map((assignment) => {
      const current = existingMap.get(`${assignment.employee_id}:${assignment.work_date}`);
      return {
        ...assignment,
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
  const { data, error } = await supabase.from('shift_assignments').select('id,revision,publication_status').eq('id', id).maybeSingle();
  if (error) fail(error, 'Không đọc được lịch phân ca.');
  if (!data) throw new Error('Lịch phân ca không còn tồn tại.');
  if (data.publication_status === 'PUBLISHED') throw new Error('Lịch đã công bố. Hãy điều chỉnh lịch thay vì xóa trực tiếp.');
  await workforceCommand('schedule.delete', { id, revision: Number(data.revision || 0) });
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
    updated_at: new Date().toISOString(),
  };
  const { error } = await supabase.from('attendance_policies').upsert(payload);
  if (error) fail(error, 'Không lưu được chính sách chấm công.');
}

export async function saveTmsLocation(location: TmsLocation) {
  const { error } = await supabase.from('locations').upsert({
    center_id: location.center_id.trim().toUpperCase(),
    center_name: location.center_name.trim(),
    address: location.address?.trim() || null,
    city: location.city?.trim() || null,
    latitude: Number(location.latitude),
    longitude: Number(location.longitude),
    radius_meters: Number(location.radius_meters),
    active: location.active,
    updated_at: new Date().toISOString(),
  });
  if (error) fail(error, 'Không lưu được địa điểm.');
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
  password?: string;
  reset_trusted_device?: boolean;
  reset_device_reason?: string;
}

export async function saveEmployee(employee: EmployeeInput, mode: 'create' | 'update') {
  const { data, error } = await supabase.functions.invoke('admin-users', { body: { action: mode, employee } });
  if (error) throw await edgeFunctionError(error, 'Không thể lưu tài khoản nhân viên.');
  if (!data?.ok) throw new Error(data?.error || 'Không thể lưu nhân viên.');
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
  const { error } = await supabase.from('config_shifts').upsert(payload);
  if (error) fail(error, 'Không lưu được cấu hình ca làm.');
}

export async function saveSystemSettings(settings: SystemSetting[]) {
  const timestamp = new Date().toISOString();
  const payload = settings.map((setting) => ({ key: setting.key, value: setting.value, updated_at: timestamp }));
  const { error } = await supabase.from('config_system').upsert(payload);
  if (error) fail(error, 'Không lưu được tham số hệ thống.');
}

export async function saveHoliday(holiday: HolidayRecord) {
  const payload = {
    ...(holiday.id ? { id: holiday.id } : {}),
    name: holiday.name.trim(),
    from_date: holiday.from_date,
    to_date: holiday.to_date,
    paid: holiday.paid,
    active: holiday.active,
    updated_at: new Date().toISOString(),
  };
  const { error } = await supabase.from('holidays').upsert(payload);
  if (error) fail(error, 'Không lưu được ngày nghỉ lễ.');
}

export async function saveQrStation(station: QrStationInfo) {
  const { error } = await supabase.rpc('update_qr_station_admin', {
    p_id: station.id,
    p_name: station.name.trim(),
    p_center_id: station.center_id,
    p_active: station.active,
  });
  if (error) fail(error, 'Không lưu được trạm QR.');
}
