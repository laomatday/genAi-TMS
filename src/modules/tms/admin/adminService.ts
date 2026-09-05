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

interface ServiceError {
  message?: string;
}

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
    if (isMissingWorkforceSchema(error)) {
      return { shiftAssignments: [], attendancePeriods: [], available: false };
    }
    fail(error, 'Không tải được dữ liệu phân ca và kỳ công.');
  }
  return {
    shiftAssignments: (assignments.data || []) as ShiftAssignment[],
    attendancePeriods: (periods.data || []) as AttendancePeriod[],
    available: true,
  };
}

async function refreshAttendanceExceptions(range: AttendanceRange) {
  const { error } = await supabase.rpc('refresh_tms_exceptions_v2', {
    p_from: range.from,
    p_to: range.to,
  });
  if (error) fail(error, 'Không đồng bộ được ngoại lệ chấm công.');
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
    if (cursorDate && cursorId) {
      query = query.or(`work_date.lt.${cursorDate},and(work_date.eq.${cursorDate},id.gt.${cursorId})`);
    }
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

  return rows
    .map((request) => ({ ...request, origin: 'timesheet' as const }))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

async function getMonthlyRequests(range: AttendanceRange): Promise<AttendanceRequest[]> {
  const rows: AttendanceRequest[] = [];
  let cursor = '';

  while (true) {
    let query = supabase
      .from('attendance_requests')
      .select('*')
      .gte('created_at', `${range.from}T00:00:00.000Z`)
      .lte('created_at', `${range.to}T23:59:59.999Z`)
      .order('id')
      .limit(TMS_LIMITS.ADMIN_FETCH_BATCH_SIZE);
    if (cursor) query = query.gt('id', cursor);
    const { data, error } = await query;
    if (error) {
      console.warn('Không tải được danh sách đơn trong tháng:', error);
      break;
    }
    const page = (data || []) as AttendanceRequest[];
    rows.push(...page);
    if (page.length < TMS_LIMITS.ADMIN_FETCH_BATCH_SIZE) break;
    cursor = page[page.length - 1]?.id || '';
    if (!cursor) break;
  }

  return rows
    .map((request) => ({ ...request, origin: 'timesheet' as const }))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

interface LegacyExplanation {
  id: string;
  employee_id: string;
  attendance_date: string;
  reason: string;
  status?: string;
  created_at: string;
  updated_at?: string;
}

async function getMonthlyLegacyExplanations(range: AttendanceRange): Promise<LegacyExplanation[]> {
  const rows: LegacyExplanation[] = [];
  let cursor = '';

  while (true) {
    let query = supabase
      .from('attendance_explanations')
      .select('id,employee_id,attendance_date,reason,status,created_at,updated_at')
      .gte('attendance_date', range.from)
      .lte('attendance_date', range.to)
      .order('id')
      .limit(TMS_LIMITS.ADMIN_FETCH_BATCH_SIZE);
    if (cursor) query = query.gt('id', cursor);
    const { data, error } = await query;
    if (error) {
      console.warn('Không tải được giải trình cũ trong tháng:', error);
      break;
    }
    const page = (data || []) as LegacyExplanation[];
    rows.push(...page);
    if (page.length < TMS_LIMITS.ADMIN_FETCH_BATCH_SIZE) break;
    cursor = page[page.length - 1]?.id || '';
    if (!cursor) break;
  }

  return rows;
}

async function getPendingLegacyExplanations(): Promise<LegacyExplanation[]> {
  const rows: LegacyExplanation[] = [];
  let cursorCreatedAt = '';
  let cursorId = '';

  while (true) {
    let query = supabase
      .from('attendance_explanations')
      .select('id,employee_id,attendance_date,reason,created_at,updated_at')
      .eq('status', 'Pending')
      .order('created_at', { ascending: false })
      .order('id')
      .limit(TMS_LIMITS.ADMIN_FETCH_BATCH_SIZE);
    if (cursorCreatedAt && cursorId) {
      query = query.or(`created_at.lt.${cursorCreatedAt},and(created_at.eq.${cursorCreatedAt},id.gt.${cursorId})`);
    }
    const { data, error } = await query;
    if (error) fail(error, 'Không tải được giải trình đang chờ duyệt.');
    const page = (data || []) as LegacyExplanation[];
    rows.push(...page);
    if (page.length < TMS_LIMITS.ADMIN_FETCH_BATCH_SIZE) break;
    cursorCreatedAt = page[page.length - 1]?.created_at || '';
    cursorId = page[page.length - 1]?.id || '';
    if (!cursorCreatedAt || !cursorId) break;
  }

  return rows;
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
    let query = supabase
      .from('employees')
      .select('*')
      .order('employee_id')
      .limit(TMS_LIMITS.ADMIN_FETCH_BATCH_SIZE);
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

export async function getAdminData(range: AttendanceRange): Promise<AdminData> {
  if (!isSupabaseConfigured) {
    throw new Error('Chưa cấu hình Supabase. Vui lòng kiểm tra biến môi trường.');
  }
  await refreshAttendanceExceptions(range);
  const [
    employees,
    locations,
    policies,
    stations,
    devices,
    shifts,
    systemSettings,
    holidays,
    auditLogs,
    timesheets,
    requests,
    legacyExplanations,
    monthlyRequestsRaw,
    monthlyLegacyRaw,
    workforce,
  ] = await Promise.all([
    getEmployees(),
    supabase.from('locations').select('*').order('center_name'),
    supabase.from('attendance_policies').select('*').order('name'),
    supabase.from('qr_stations').select('*').order('updated_at', { ascending: false }),
    supabase
      .from('trusted_devices')
      .select('device_id,employee_id,device_label,user_agent,status,activated_at,last_seen_at')
      .order('activated_at', { ascending: false }),
    supabase.from('config_shifts').select('*').order('sort_order'),
    supabase.from('config_system').select('key,value,updated_at').order('key'),
    supabase.from('holidays').select('*').order('from_date', { ascending: false }),
    supabase.from('audit_logs').select('*').order('created_at', { ascending: false }).limit(TMS_LIMITS.ADMIN_AUDIT_QUERY_LIMIT),
    getTimesheets(range),
    getPendingRequests(),
    getPendingLegacyExplanations(),
    getMonthlyRequests(range),
    getMonthlyLegacyExplanations(range),
    getWorkforceOperations(range),
  ]);

  for (const result of [locations, policies, stations, devices, shifts, systemSettings, holidays, auditLogs]) {
    if (result.error) fail(result.error, 'Không tải được dữ liệu quản trị.');
  }

  const timesheetIds = new Map(timesheets.map((timesheet) => [`${timesheet.employee_id}:${timesheet.work_date}`, timesheet.id]));
  const legacyRequests: AttendanceRequest[] = legacyExplanations.map((request) => ({
    id: request.id,
    timesheet_id: timesheetIds.get(`${request.employee_id}:${request.attendance_date}`) || '',
    employee_id: request.employee_id,
    request_type: 'EXPLANATION',
    reason: request.reason,
    status: 'PENDING',
    created_at: request.created_at,
    updated_at: request.updated_at,
    work_date: request.attendance_date,
    origin: 'legacy',
  }));

  const mapMonthlyLegacyToRequest = (item: LegacyExplanation): AttendanceRequest => {
    let normStatus: 'PENDING' | 'APPROVED' | 'REJECTED' = 'PENDING';
    const s = item.status?.toUpperCase();
    if (s === 'APPROVED') normStatus = 'APPROVED';
    else if (s === 'REJECTED') normStatus = 'REJECTED';

    return {
      id: item.id,
      timesheet_id: timesheetIds.get(`${item.employee_id}:${item.attendance_date}`) || '',
      employee_id: item.employee_id,
      request_type: 'EXPLANATION',
      reason: item.reason,
      status: normStatus,
      created_at: item.created_at,
      updated_at: item.updated_at,
      work_date: item.attendance_date,
      origin: 'legacy',
    };
  };

  const monthlyCombined = [
    ...monthlyRequestsRaw,
    ...monthlyLegacyRaw.map(mapMonthlyLegacyToRequest),
  ].sort((a, b) => b.created_at.localeCompare(a.created_at));

  return {
    employees,
    locations: (locations.data || []) as TmsLocation[],
    policies: (policies.data || []) as AttendancePolicy[],
    timesheets,
    requests: [...requests, ...legacyRequests].sort((a, b) => b.created_at.localeCompare(a.created_at)),
    monthlyRequests: monthlyCombined,
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
  if (!isSupabaseConfigured) {
    return { id: request.id, status, note };
  }
  if (request.origin === 'legacy') {
    const { error } = await supabase.rpc('review_attendance_explanation', {
      p_id: request.id,
      p_status: status === 'APPROVED' ? 'Approved' : 'Rejected',
      p_note: note,
    });
    if (error) fail(error, 'Không xử lý được giải trình.');
    if (status === 'APPROVED' && request.employee_id && request.work_date) {
      try {
        await supabase
          .from('attendance')
          .update({ status: 'Valid', is_valid: 'Yes' })
          .eq('employee_id', request.employee_id)
          .eq('date', request.work_date);
      } catch {
        // Suppress if direct update is restricted by RLS
      }
      try {
        await supabase
          .from('timesheets')
          .update({ status: 'VALID' })
          .eq('employee_id', request.employee_id)
          .eq('work_date', request.work_date);
      } catch {
        // Suppress if timesheet row does not exist
      }
    }
    return;
  }
  const { data, error } = await supabase.rpc('review_attendance_request_v2', {
    p_id: request.id,
    p_status: status,
    p_note: note,
  });
  if (error) fail(error, 'Không xử lý được yêu cầu.');
  if (status === 'APPROVED' && request.employee_id && request.work_date) {
    try {
      await supabase
        .from('attendance')
        .update({ status: 'Valid', is_valid: 'Yes' })
        .eq('employee_id', request.employee_id)
        .eq('date', request.work_date);
    } catch {
      // Suppress
    }
  }
  return data;
}

export async function reviewAttendanceRequestsBulk(
  requests: AttendanceRequest[],
  status: 'APPROVED' | 'REJECTED',
  note = '',
) {
  if (!requests.length) return 0;
  if (!isSupabaseConfigured) {
    return requests.length;
  }
  try {
    const { data, error } = await supabase.rpc('review_attendance_requests_bulk_v1', {
      p_requests: requests.map((request) => ({ id: request.id, origin: request.origin || 'timesheet' })),
      p_status: status,
      p_note: note,
    });
    if (!error) return Number(data || requests.length);
  } catch {
    // Fallback to sequential review if bulk RPC is unavailable
  }

  let processedCount = 0;
  for (const request of requests) {
    await reviewAttendanceRequest(request, status, note);
    processedCount++;
  }
  return processedCount;
}

export async function saveShiftAssignments(assignments: Array<{
  employee_id: string;
  work_date: string;
  shift_id: number;
  location_id?: string | null;
  note?: string;
}>) {
  const { data, error } = await supabase.rpc('save_shift_assignments_v1', { p_assignments: assignments });
  if (error) fail(error, 'Không lưu được lịch phân ca.');
  return Number(data || 0);
}

export async function deleteShiftAssignment(id: string, reason = '') {
  const { error } = await supabase.rpc('delete_shift_assignment_v1', { p_id: id, p_reason: reason });
  if (error) fail(error, 'Không xóa được lịch phân ca.');
}

export async function closeAttendancePeriod(range: AttendanceRange, note = '') {
  const { data, error } = await supabase.rpc('close_attendance_period_v1', {
    p_from: range.from,
    p_to: range.to,
    p_note: note,
  });
  if (error) fail(error, 'Không đóng được kỳ công.');
  return data as { locked_count?: number } | null;
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
  const { data, error } = await supabase.functions.invoke('admin-users', {
    body: { action: mode, employee },
  });
  if (error) throw await edgeFunctionError(error, 'Không thể lưu tài khoản nhân viên.');
  if (!data?.ok) throw new Error(data?.error || 'Không thể lưu nhân viên.');
  return data;
}

export async function deleteEmployeeAccount(employeeId: string) {
  const { data, error } = await supabase.functions.invoke('admin-users', {
    body: { action: 'delete', employee: { employee_id: employeeId } },
  });
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
  const payload = settings.map((setting) => ({
    key: setting.key,
    value: setting.value,
    updated_at: timestamp,
  }));
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
  if (error) fail(error, 'Không lưu được trạm Kiosk.');
}
