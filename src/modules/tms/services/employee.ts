import { supabase, isSupabaseConfigured } from '@/core/supabase';
import { timeToMinutes, toLocalMonthString } from '@/core/utils/helpers';
import {
  TMS_DEFAULT_SHIFTS,
  TMS_DEFAULT_SYSTEM_CONFIG,
  TMS_DEFAULTS,
  TMS_LIMITS,
  TMS_STORAGE,
} from '@/shared/constants';
import type {
  DashboardData,
  Employee,
  EmployeeRole,
  Explanation,
  HolidayConfig,
  LeaveRequest,
  LocationConfig,
  ReviewStatus,
  ShiftConfig,
  SystemConfig,
} from '@/shared/types';
import { getAttendanceBootstrap } from './attendance';

type DataRow = Record<string, unknown>;
type DecisionStatus = Exclude<ReviewStatus, 'Pending'>;

const EMPLOYEE_ROLES: readonly EmployeeRole[] = ['Staff', 'Leader', 'Manager', 'Director', 'Admin', 'HR', 'Kiosk'];
const REVIEW_STATUSES: readonly ReviewStatus[] = ['Pending', 'Approved', 'Rejected'];

function textValue(value: unknown, fallback = '') {
  return typeof value === 'string' ? value : value == null ? fallback : String(value);
}

function optionalText(value: unknown) {
  const valueAsText = textValue(value).trim();
  return valueAsText || undefined;
}

function numberValue(value: unknown, fallback = 0) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function employeeRole(value: unknown): EmployeeRole {
  return EMPLOYEE_ROLES.includes(value as EmployeeRole) ? value as EmployeeRole : 'Staff';
}

function reviewStatus(value: unknown): ReviewStatus {
  return REVIEW_STATUSES.includes(value as ReviewStatus) ? value as ReviewStatus : 'Pending';
}

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    return error.message;
  }
  return fallback;
}

function ok(message: string) {
  return { success: true as const, message };
}

function err(error: unknown, fallback = 'Không thể hoàn tất thao tác.') {
  return { success: false as const, message: errorMessage(error, fallback) };
}

function defaultSystemConfig(): SystemConfig {
  return { ...TMS_DEFAULT_SYSTEM_CONFIG, OFF_DAYS: [...TMS_DEFAULT_SYSTEM_CONFIG.OFF_DAYS] };
}

async function getSystemConfig(): Promise<SystemConfig> {
  const { data, error } = await supabase.from('config_system').select('key,value');
  if (error) return defaultSystemConfig();

  const config = defaultSystemConfig();
  for (const row of (data || []) as DataRow[]) {
    const key = textValue(row.key);
    const value = row.value;
    switch (key) {
      case 'OFF_DAYS':
        config.OFF_DAYS = textValue(value).split(',').map(Number).filter(Number.isFinite);
        break;
      case 'LUNCH_START':
        config.LUNCH_START = textValue(value, config.LUNCH_START);
        break;
      case 'LUNCH_END':
        config.LUNCH_END = textValue(value, config.LUNCH_END);
        break;
      case 'LATE_TOLERANCE':
        config.LATE_TOLERANCE = numberValue(value, config.LATE_TOLERANCE);
        break;
      case 'MIN_HOURS_FULL':
        config.MIN_HOURS_FULL = numberValue(value, config.MIN_HOURS_FULL);
        break;
      case 'MIN_HOURS_HALF':
        config.MIN_HOURS_HALF = numberValue(value, config.MIN_HOURS_HALF);
        break;
      case 'MAX_DISTANCE_METERS':
        config.MAX_DISTANCE_METERS = numberValue(value, config.MAX_DISTANCE_METERS);
        break;
      case 'LOCK_DATE':
        config.LOCK_DATE = numberValue(value, config.LOCK_DATE);
        break;
      case 'MAX_EXPLANATIONS_PER_MONTH':
        config.MAX_EXPLANATIONS_PER_MONTH = numberValue(value, config.MAX_EXPLANATIONS_PER_MONTH);
        break;
      case 'QR_REFRESH_SECONDS':
        config.QR_REFRESH_SECONDS = numberValue(value, config.QR_REFRESH_SECONDS);
        break;
      case 'QR_VALIDITY_SECONDS':
        config.QR_VALIDITY_SECONDS = numberValue(value, config.QR_VALIDITY_SECONDS);
        break;
    }
  }
  return config;
}

async function getShifts(): Promise<ShiftConfig[]> {
  const { data, error } = await supabase.from('config_shifts').select('*').eq('active', true).order('sort_order');
  if (error || !data?.length) return TMS_DEFAULT_SHIFTS.map((shift) => ({ ...shift }));

  return (data as DataRow[]).map((shift) => ({
    name: textValue(shift.name),
    start: textValue(shift.start_time).slice(0, 5),
    end: textValue(shift.end_time).slice(0, 5),
    break_point: textValue(shift.break_point).slice(0, 5),
  }));
}

export function determineShift(timeStr: string, shifts: ShiftConfig[]): ShiftConfig {
  const fallback: ShiftConfig = { ...TMS_DEFAULT_SHIFTS[0] };
  if (!shifts.length) return fallback;

  const sorted = [...shifts].sort((a, b) => timeToMinutes(a.start) - timeToMinutes(b.start));
  const current = timeToMinutes(timeStr);
  const firstShift = sorted[0] ?? fallback;
  if (current < timeToMinutes(firstShift.start)) return firstShift;

  for (const shift of sorted) {
    let boundary = timeToMinutes(shift.break_point || shift.end);
    const start = timeToMinutes(shift.start);
    if (boundary < start) boundary += 1440;
    if (current <= boundary) return shift;
  }
  return sorted[sorted.length - 1] ?? firstShift;
}

function mapContact(row: DataRow): Employee {
  const employeeId = textValue(row.employee_id);
  const avatarUrl = optionalText(row.avatar_url);
  return {
    id: employeeId,
    employee_id: employeeId,
    name: textValue(row.name),
    email: textValue(row.email),
    phone: optionalText(row.phone),
    role: employeeRole(row.role),
    center_id: textValue(row.center_id),
    position: optionalText(row.position_title) ?? optionalText(row.position),
    department: optionalText(row.department),
    avatar_url: avatarUrl,
    face_ref_url: avatarUrl,
    direct_manager_id: optionalText(row.direct_manager_id) ?? null,
    managed_locations: stringArray(row.managed_locations),
    allowed_locations: stringArray(row.allowed_locations),
    annual_leave_balance: numberValue(row.annual_leave_balance, TMS_DEFAULTS.ANNUAL_LEAVE_DAYS),
    status: 'Active',
  };
}

function mapLeaveRequest(row: DataRow): LeaveRequest {
  const id = textValue(row.id || row.request_id);
  return {
    id,
    request_id: optionalText(row.request_id),
    employee_id: textValue(row.employee_id),
    name: optionalText(row.name),
    created_at: textValue(row.created_at),
    type: textValue(row.type),
    from_date: textValue(row.from_date),
    to_date: textValue(row.to_date),
    reason: textValue(row.reason),
    status: reviewStatus(row.status),
    note: optionalText(row.note),
    manager_note: optionalText(row.manager_note),
    approver_id: optionalText(row.approver_id) ?? null,
    updated_at: optionalText(row.updated_at),
  };
}

function mapExplanation(row: DataRow): Explanation {
  return {
    id: textValue(row.id),
    employee_id: textValue(row.employee_id),
    name: optionalText(row.name),
    date: textValue(row.attendance_date || row.date),
    attendance_date: optionalText(row.attendance_date),
    reason: textValue(row.reason),
    status: reviewStatus(row.status),
    created_at: textValue(row.created_at),
    manager_note: optionalText(row.manager_note),
    approver_id: optionalText(row.approver_id) ?? null,
    updated_at: optionalText(row.updated_at),
  };
}

function mapLocation(row: DataRow): LocationConfig {
  return {
    center_id: textValue(row.center_id),
    location_name: textValue(row.center_name),
    center_name: textValue(row.center_name),
    address: optionalText(row.address),
    city: optionalText(row.city),
    latitude: numberValue(row.latitude),
    longitude: numberValue(row.longitude),
    radius_meters: numberValue(row.radius_meters, TMS_LIMITS.DEFAULT_GEOFENCE_METERS),
    active: row.active !== false,
  };
}

function mapHoliday(row: DataRow): HolidayConfig {
  return {
    id: numberValue(row.id),
    name: textValue(row.name),
    from_date: textValue(row.from_date),
    to_date: textValue(row.to_date),
    paid: row.paid !== false,
    active: row.active !== false,
  };
}

export async function getDashboardData(employeeId: string): Promise<{ success: boolean; data?: DashboardData; message?: string }> {
  try {
    if (!isSupabaseConfigured) {
      throw new Error('Chưa cấu hình Supabase. Vui lòng kiểm tra biến môi trường.');
    }

    const [boot, config, shifts, locationResult, holidayResult, requestResult, explanationResult, contactResult, allRequestResult, allExplanationResult] = await Promise.all([
      getAttendanceBootstrap(),
      getSystemConfig(),
      getShifts(),
      supabase.from('locations').select('*').eq('active', true).order('center_name'),
      supabase.from('holidays').select('*').eq('active', true).order('from_date'),
      supabase.from('leave_requests').select('*').eq('employee_id', employeeId).order('created_at', { ascending: false }),
      supabase.from('attendance_explanations').select('*').eq('employee_id', employeeId).order('created_at', { ascending: false }),
      supabase.rpc('get_employee_directory'),
      supabase.from('leave_requests').select('*').order('created_at', { ascending: false }),
      supabase.from('attendance_explanations').select('*').order('created_at', { ascending: false }),
    ]);

    for (const result of [locationResult, holidayResult, requestResult, explanationResult, contactResult, allRequestResult, allExplanationResult]) {
      if (result.error) throw result.error;
    }

    const locations = ((locationResult.data || []) as DataRow[]).map(mapLocation);
    const holidays = ((holidayResult.data || []) as DataRow[]).map(mapHoliday);
    const contacts = ((contactResult.data || []) as DataRow[]).map(mapContact);
    const myRequests = ((requestResult.data || []) as DataRow[]).map(mapLeaveRequest);
    const myExplanations = ((explanationResult.data || []) as DataRow[]).map(mapExplanation);
    const allRequests = ((allRequestResult.data || []) as DataRow[]).map(mapLeaveRequest);
    const allExplanations = ((allExplanationResult.data || []) as DataRow[]).map(mapExplanation);

    const contactIds = new Set(contacts.map((contact) => contact.employee_id));
    const teamLeaves = allRequests.filter((request) => contactIds.has(request.employee_id) && (request.status === 'Approved' || request.status === 'Pending'));
    const approvals = allRequests.filter((request) => request.status === 'Pending' && request.employee_id !== employeeId);
    const explanationApprovals = allExplanations.filter((request) => request.status === 'Pending' && request.employee_id !== employeeId);

    const approvedExplanationDates = new Set(
      myExplanations.filter((exp) => exp.status === 'Approved').map((exp) => exp.date)
    );

    const synchronizedHistory = boot.history.map((attendance) => {
      if (approvedExplanationDates.has(attendance.date)) {
        return {
          ...attendance,
          status: 'Valid' as const,
          is_valid: 'Yes' as const,
        };
      }
      return attendance;
    });

    const month = toLocalMonthString();
    const monthHistory = synchronizedHistory.filter((attendance) => attendance.date.startsWith(month));
    const approvedLeave = myRequests.filter((request) => request.status === 'Approved' && request.from_date.startsWith(month)).length;
    const validAttendanceDates = new Set(monthHistory.filter((att) => att.status !== 'Invalid').map((att) => att.date));
    const approvedAbsentDaysInMonth = Array.from(approvedExplanationDates).filter(
      (d) => d.startsWith(month) && !validAttendanceDates.has(d)
    ).length;

    const summary = {
      workDays: validAttendanceDates.size + approvedAbsentDaysInMonth,
      lateMins: monthHistory.reduce((sum, attendance) => sum + numberValue(attendance.late_minutes), 0),
      leaveDays: approvedLeave,
      remainingLeave: numberValue(boot.profile.annual_leave_balance, TMS_DEFAULTS.ANNUAL_LEAVE_DAYS),
      standardDays: TMS_DEFAULTS.STANDARD_WORK_DAYS_PER_MONTH,
      errorCount: monthHistory.filter((attendance) => attendance.status === 'Invalid' && !approvedExplanationDates.has(attendance.date)).length,
    };

    return {
      success: true,
      data: {
        userProfile: boot.profile,
        history: { history: synchronizedHistory, summary },
        notifications: { approvals, explanationApprovals, myRequests, myExplanations },
        myRequests,
        myExplanations,
        teamLeaves,
        locations,
        contacts,
        holidays,
        shifts,
        systemConfig: config,
      },
    };
  } catch (error) {
    return { success: false, message: errorMessage(error, 'Không tải được dữ liệu.') };
  }
}

interface SubmitRequestInput {
  type: string;
  fromDate: string;
  toDate: string;
  reason: string;
}

export async function submitRequest(input: SubmitRequestInput) {
  try {
    const { error } = await supabase.rpc('submit_leave_request', {
      p_type: input.type,
      p_from_date: input.fromDate,
      p_to_date: input.toDate,
      p_reason: input.reason,
    });
    if (error) throw error;
    return ok('Gửi đề xuất thành công!');
  } catch (error) {
    return err(error);
  }
}

export async function submitExplanation(input: { date: string; reason: string }) {
  try {
    const { error } = await supabase.rpc('submit_attendance_explanation', {
      p_attendance_date: input.date,
      p_reason: input.reason,
    });
    if (error) throw error;
    return ok('Gửi giải trình thành công!');
  } catch (error) {
    return err(error);
  }
}

async function deletePending(table: 'leave_requests' | 'attendance_explanations', id: string) {
  const { data, error } = await supabase.from(table).delete().eq('id', id).eq('status', 'Pending').select('id').maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('Yêu cầu không còn tồn tại hoặc đã được xử lý.');
}

export async function deleteRequest(id: string) {
  try {
    await deletePending('leave_requests', id);
    return ok('Đã xoá đơn!');
  } catch (error) {
    return err(error);
  }
}

export async function deleteExplanation(id: string) {
  try {
    await deletePending('attendance_explanations', id);
    return ok('Đã xoá giải trình!');
  } catch (error) {
    return err(error);
  }
}

export async function processRequest(id: string, status: DecisionStatus, note: string) {
  try {
    const { error } = await supabase.rpc('review_leave_request', { p_id: id, p_status: status, p_note: note });
    if (error) throw error;
    return ok('Đã xử lý!');
  } catch (error) {
    return err(error);
  }
}

export async function processExplanation(id: string, status: DecisionStatus, note: string) {
  try {
    const { error } = await supabase.rpc('review_attendance_explanation', { p_id: id, p_status: status, p_note: note });
    if (error) throw error;
    return ok('Đã xử lý!');
  } catch (error) {
    return err(error);
  }
}

function rpcText(data: unknown, field: string) {
  if (!data || typeof data !== 'object' || !(field in data)) return undefined;
  return optionalText((data as DataRow)[field]);
}

export async function doCheckOut(position: { lat: number; lng: number; accuracy: number }) {
  try {
    const { lat, lng, accuracy } = position;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error('Vui lòng bật GPS.');
    if (!Number.isFinite(accuracy) || accuracy <= 0 || accuracy > TMS_LIMITS.MAX_GPS_ACCURACY_METERS) {
      throw new Error(`Tín hiệu GPS chưa đủ chính xác (${Math.round(accuracy)}m).`);
    }
    const { data, error } = await supabase.rpc('checkout_attendance_gps', { p_lat: lat, p_lng: lng, p_accuracy: accuracy });
    if (error) throw error;
    return ok(rpcText(data, 'message') || 'Check-out thành công!');
  } catch (error) {
    return err(error);
  }
}

export async function togglePause() {
  try {
    const { data, error } = await supabase.rpc('toggle_attendance_pause');
    if (error) throw error;
    return {
      success: true as const,
      message: rpcText(data, 'message') || 'Đã cập nhật trạng thái.',
      action: rpcText(data, 'action'),
    };
  } catch (error) {
    return err(error);
  }
}

function avatarBlob(value: Blob | string) {
  if (value instanceof Blob) return value;

  try {
    const separatorIndex = value.indexOf(',');
    const header = value.slice(0, separatorIndex);
    const payload = value.slice(separatorIndex + 1);
    if (separatorIndex < 0 || !header.startsWith('data:') || !header.endsWith(';base64') || !payload) {
      throw new Error('Invalid data URL');
    }

    const mimeType = header.slice('data:'.length, -';base64'.length);
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new Blob([bytes], { type: mimeType });
  } catch {
    throw new Error('Dữ liệu ảnh đại diện không hợp lệ. Vui lòng chọn lại ảnh.');
  }
}

export async function updateProfileAvatar(image: Blob | string) {
  try {
    const { data: authData, error: authError } = await supabase.auth.getUser();
    if (authError || !authData.user) throw new Error('Phiên đăng nhập không hợp lệ.');
    const avatar = avatarBlob(image);
    if (!TMS_STORAGE.AVATAR_MIME_TYPES.includes(avatar.type as typeof TMS_STORAGE.AVATAR_MIME_TYPES[number])) {
      throw new Error('Ảnh đại diện phải là JPEG, PNG hoặc WebP.');
    }
    if (avatar.size > TMS_LIMITS.MAX_AVATAR_STORAGE_BYTES) {
      throw new Error('Ảnh sau khi xử lý vẫn vượt quá dung lượng lưu trữ.');
    }

    const path = `${authData.user.id}/${TMS_STORAGE.AVATAR_FILE_NAME}`;
    const { error: uploadError } = await supabase.storage.from(TMS_STORAGE.AVATAR_BUCKET).upload(path, avatar, {
      contentType: avatar.type,
      cacheControl: String(TMS_STORAGE.AVATAR_CACHE_SECONDS),
      upsert: true,
    });
    if (uploadError) throw new Error(`Không thể tải ảnh lên kho lưu trữ: ${uploadError.message}`);
    const { data: publicUrlData } = supabase.storage.from(TMS_STORAGE.AVATAR_BUCKET).getPublicUrl(path);
    const avatarUrl = `${publicUrlData.publicUrl}?v=${Date.now()}`;
    const { error: profileError } = await supabase.rpc('set_my_avatar', { p_url: avatarUrl });
    if (profileError) throw new Error(`Ảnh đã tải lên nhưng chưa thể cập nhật hồ sơ: ${profileError.message}`);
    return { ...ok('Đã cập nhật ảnh đại diện.'), avatarUrl };
  } catch (error) {
    return err(error);
  }
}

export async function changePassword(oldPassword: string, newPassword: string) {
  try {
    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError || !userData.user?.email) throw new Error('Phiên đăng nhập không hợp lệ.');
    const { error: verificationError } = await supabase.auth.signInWithPassword({ email: userData.user.email, password: oldPassword });
    if (verificationError) throw new Error('Mật khẩu hiện tại không đúng.');
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) throw error;
    return ok('Đổi mật khẩu thành công.');
  } catch (error) {
    return err(error);
  }
}
