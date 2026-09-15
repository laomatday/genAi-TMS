import { supabase, isSupabaseConfigured } from '@/core/supabase';
import { timeToMinutes } from '@/core/utils/helpers';
import { assertValidAttendancePosition } from '@/modules/tms/utils/attendancePosition';
import {
  APPROVAL_CONFIG_KEY,
  normalizeApprovalRoles,
  TMS_DEFAULT_SHIFTS,
  TMS_DEFAULT_SYSTEM_CONFIG,
  TMS_LIMITS,
  TMS_STORAGE,
  TMS_TIME,
  type ApprovalRoleConfig,
} from '@/shared/constants';
import type {
  Attendance,
  DashboardData,
  Employee,
  EmployeeRole,
  Explanation,
  HolidayConfig,
  LeaveRequest,
  LocationConfig,
  LocationLabel,
  ReviewStatus,
  ShiftConfig,
  SystemConfig,
  WorkforceRequestType,
} from '@/shared/types';
import { commandId, runAttendanceAction } from './attendance';
import { reportClientMetric } from '@/core/observability/clientTelemetry';
import { queryWorkforce, queryWorkforceRows } from './workforceApi';

type DataRow = Record<string, unknown>;
type DecisionStatus = Exclude<ReviewStatus, 'Pending'>;

const EMPLOYEE_ROLES: readonly EmployeeRole[] = ['Staff', 'Leader', 'Manager', 'Director', 'Admin', 'HR', 'Kiosk'];
const WORKFORCE_LEAVE_TYPES: WorkforceRequestType[] = [
  'ANNUAL_LEAVE',
  'SICK_LEAVE',
  'UNPAID_LEAVE',
  'BUSINESS_TRIP',
  'REMOTE_WORK',
  'SHIFT_SWAP',
  'OVERTIME',
];

const REQUEST_LABELS: Record<WorkforceRequestType, string> = {
  EXPLANATION: 'Giải trình',
  CORRECTION: 'Điều chỉnh công',
  ANNUAL_LEAVE: 'Nghỉ phép',
  SICK_LEAVE: 'Nghỉ ốm',
  UNPAID_LEAVE: 'Nghỉ không lương',
  BUSINESS_TRIP: 'Công tác',
  REMOTE_WORK: 'Làm việc tại nhà',
  SHIFT_SWAP: 'Đổi ca',
  OVERTIME: 'Tăng ca',
};

const REQUEST_CODES: Record<string, WorkforceRequestType> = {
  'nghỉ phép': 'ANNUAL_LEAVE',
  'nghỉ ốm': 'SICK_LEAVE',
  'nghỉ không lương': 'UNPAID_LEAVE',
  'công tác': 'BUSINESS_TRIP',
  'làm việc tại nhà': 'REMOTE_WORK',
  wfh: 'REMOTE_WORK',
  'đổi ca': 'SHIFT_SWAP',
  'tăng ca': 'OVERTIME',
};

const timeFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Ho_Chi_Minh',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function textValue(value: unknown, fallback = '') {
  return typeof value === 'string' ? value : value == null ? fallback : String(value);
}

function optionalText(value: unknown) {
  const text = textValue(value).trim();
  return text || undefined;
}

function numberValue(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message;
  return fallback;
}

function ok(message: string) {
  return { success: true as const, message };
}

function err(error: unknown, fallback = 'Không thể hoàn tất thao tác.') {
  return { success: false as const, message: errorMessage(error, fallback) };
}

function employeeRole(value: unknown): EmployeeRole {
  return EMPLOYEE_ROLES.includes(value as EmployeeRole) ? value as EmployeeRole : 'Staff';
}

function normalizeStatus(value: unknown): ReviewStatus | null {
  const status = textValue(value).toUpperCase();
  if (status === 'PENDING') return 'Pending';
  if (status === 'APPROVED') return 'Approved';
  if (status === 'REJECTED') return 'Rejected';
  return null;
}

function requestType(value: unknown): WorkforceRequestType | null {
  const type = textValue(value).toUpperCase() as WorkforceRequestType;
  return [...WORKFORCE_LEAVE_TYPES, 'EXPLANATION', 'CORRECTION'].includes(type) ? type : null;
}

function requestCode(value: string): WorkforceRequestType {
  const trimmed = value.trim();
  const upper = trimmed.toUpperCase() as WorkforceRequestType;
  if ([...WORKFORCE_LEAVE_TYPES, 'EXPLANATION', 'CORRECTION'].includes(upper)) return upper;
  return REQUEST_CODES[trimmed.toLowerCase()] || 'ANNUAL_LEAVE';
}

function localTime(value: unknown, timezone: string = TMS_TIME.ZONE) {
  const text = optionalText(value);
  if (!text) return '';
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return '';
  if (timezone === TMS_TIME.ZONE) return timeFormatter.format(date);
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function profileFrom(row: DataRow): Employee {
  const employeeId = textValue(row.employee_id);
  return {
    ...(row as unknown as Employee),
    id: employeeId,
    employee_id: employeeId,
    uid: optionalText(row.auth_user_id),
    auth_user_id: optionalText(row.auth_user_id),
    organization_id: optionalText(row.organization_id),
    name: textValue(row.name),
    email: textValue(row.email),
    phone: optionalText(row.phone),
    role: employeeRole(row.role),
    center_id: textValue(row.center_id),
    attendance_policy_id: optionalText(row.attendance_policy_id) ?? null,
    allowed_locations: stringArray(row.allowed_locations),
    managed_locations: stringArray(row.managed_locations),
    direct_manager_id: optionalText(row.direct_manager_id) ?? null,
    annual_leave_balance: numberValue(row.annual_leave_balance),
    avatar_url: optionalText(row.avatar_url),
    face_ref_url: optionalText(row.face_ref_url),
    position: optionalText(row.position),
    department: optionalText(row.department),
    status: row.status === 'Inactive' ? 'Inactive' : 'Active',
  };
}

function mapShift(row: DataRow): ShiftConfig {
  return {
    name: textValue(row.name, 'Ca làm việc'),
    start: textValue(row.start_time).slice(0, 5),
    end: textValue(row.end_time).slice(0, 5),
    break_point: optionalText(row.break_point)?.slice(0, 5),
  };
}

function mapLocation(row: DataRow): LocationConfig {
  const centerName = textValue(row.center_name, textValue(row.center_id));
  return {
    center_id: textValue(row.center_id),
    location_name: centerName,
    center_name: centerName,
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

interface DirectoryPerson {
  role: EmployeeRole;
  direct_manager_id: string | null;
}

function mapLocationLabel(row: DataRow): LocationLabel {
  const centerId = textValue(row.center_id);
  return {
    center_id: centerId,
    center_name: textValue(row.center_name, centerId),
    city: optionalText(row.city),
    active: row.active !== false,
  };
}

function mapDirectoryPeople(rows: unknown): Record<string, DirectoryPerson> {
  const map: Record<string, DirectoryPerson> = {};
  if (!Array.isArray(rows)) return map;
  rows.forEach((entry) => {
    const row = entry as DataRow;
    const employeeId = textValue(row.employee_id);
    if (!employeeId) return;
    const role = textValue(row.role) as EmployeeRole;
    map[employeeId] = {
      role: EMPLOYEE_ROLES.includes(role) ? role : 'Staff',
      direct_manager_id: optionalText(row.direct_manager_id) || null,
    };
  });
  return map;
}

function mapContact(row: DataRow, people: Record<string, DirectoryPerson> = {}): Employee {
  const employeeId = textValue(row.employee_id);
  const person = people[employeeId];
  return {
    id: employeeId,
    employee_id: employeeId,
    name: textValue(row.name),
    email: textValue(row.email),
    phone: optionalText(row.phone),
    role: person?.role || 'Staff',
    direct_manager_id: person?.direct_manager_id ?? null,
    center_id: textValue(row.center_id),
    position: optionalText(row.position),
    department: optionalText(row.department),
    avatar_url: optionalText(row.avatar_url),
    face_ref_url: optionalText(row.avatar_url),
    status: row.status === 'Inactive' ? 'Inactive' : 'Active',
  };
}

function shiftNameFor(row: DataRow, shifts: ShiftConfig[], policyName = '', timezone: string = TMS_TIME.ZONE) {
  const start = localTime(row.expected_start, timezone);
  const end = localTime(row.expected_end, timezone);
  const matched = shifts.find((shift) => shift.start === start && shift.end === end)?.name;
  // A timesheet driven by the attendance policy has no matching config_shifts row,
  // so the policy name is the real label; the generic text is the last resort.
  return matched || optionalText(row.shift_name) || policyName || 'Ca làm việc';
}

function mapTimesheet(row: DataRow, profile: Employee, shifts: ShiftConfig[], policyName = '', timezone: string = TMS_TIME.ZONE): Attendance {
  const exceptionCodes = stringArray(row.exception_codes);
  const status = textValue(row.status);
  const lateMinutes = numberValue(row.late_minutes);
  const invalid = status === 'EXCEPTION' || status === 'NEEDS_REVIEW' || status === 'REJECTED';
  const actualCheckin = optionalText(row.actual_checkin);
  const actualCheckout = optionalText(row.actual_checkout);
  const expectedStart = optionalText(row.expected_start);
  const createdAt = optionalText(row.created_at);
  const workDate = textValue(row.work_date, textValue(row.business_date));
  const timestampSource = actualCheckin || expectedStart || createdAt || `${workDate}T00:00:00`;
  const timestamp = new Date(timestampSource).getTime();

  return {
    id: textValue(row.id),
    date: workDate,
    employee_id: textValue(row.employee_id, profile.employee_id),
    name: textValue(row.employee_name, profile.name),
    center_id: textValue(row.location_id, profile.center_id),
    location_name: optionalText(row.location_name) || textValue(row.location_id, profile.center_id),
    shift_name: shiftNameFor(row, shifts, policyName, timezone),
    shift_start: localTime(row.expected_start, timezone),
    shift_end: localTime(row.expected_end, timezone),
    time_in: localTime(actualCheckin, timezone),
    time_out: localTime(actualCheckout, timezone),
    checkin_type: 'QR_GPS',
    checkin_lat: 0,
    checkin_lng: 0,
    distance_meters: 0,
    late_minutes: lateMinutes,
    early_minutes: numberValue(row.early_minutes),
    work_hours: Math.round((numberValue(row.work_minutes) / 60) * 100) / 100,
    status: invalid ? 'Invalid' : lateMinutes > 0 ? 'Late' : 'Valid',
    is_valid: invalid ? 'No' : 'Yes',
    note: exceptionCodes.join(', '),
    timestamp: Number.isFinite(timestamp) ? timestamp : 0,
    last_updated: optionalText(row.updated_at),
    break_start: optionalText(row.break_started_at),
    total_break_mins: numberValue(row.break_minutes),
  };
}

function mapLeave(row: DataRow): LeaveRequest | null {
  const type = requestType(row.request_type);
  const status = normalizeStatus(row.status);
  if (!type || !status || type === 'EXPLANATION' || type === 'CORRECTION') return null;
  return {
    id: textValue(row.id),
    request_id: textValue(row.id),
    request_code: optionalText(row.request_code),
    employee_id: textValue(row.employee_id),
    name: optionalText(row.employee_name),
    created_at: textValue(row.created_at),
    type: REQUEST_LABELS[type],
    request_type: type,
    from_date: textValue(row.from_date),
    to_date: textValue(row.to_date),
    reason: textValue(row.reason),
    status,
    manager_note: optionalText(row.manager_note),
    approver_id: optionalText(row.approver_id) ?? null,
    assigned_to: optionalText(row.assigned_to) ?? null,
    fallback_to: optionalText(row.fallback_to) ?? null,
    due_at: optionalText(row.due_at),
    revision: numberValue(row.revision, 1),
    workflow_data: row.workflow_data && typeof row.workflow_data === 'object' ? row.workflow_data as Record<string, unknown> : undefined,
    updated_at: optionalText(row.updated_at),
  };
}

function mapExplanation(row: DataRow): Explanation | null {
  const type = requestType(row.request_type);
  const status = normalizeStatus(row.status);
  if ((type !== 'EXPLANATION' && type !== 'CORRECTION') || !status) return null;
  return {
    id: textValue(row.id),
    request_code: optionalText(row.request_code),
    employee_id: textValue(row.employee_id),
    name: optionalText(row.employee_name),
    date: textValue(row.from_date),
    attendance_date: textValue(row.from_date),
    reason: textValue(row.reason),
    status,
    request_type: type,
    requested_checkin: optionalText(row.requested_checkin) ?? null,
    requested_checkout: optionalText(row.requested_checkout) ?? null,
    manager_note: optionalText(row.manager_note),
    approver_id: optionalText(row.approver_id) ?? null,
    revision: numberValue(row.revision, 1),
    updated_at: optionalText(row.updated_at),
    created_at: textValue(row.created_at),
  };
}

function monthBounds() {
  const now = new Date();
  return {
    year: now.getFullYear(),
    month: now.getMonth(),
    key: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`,
  };
}

function dateOnly(value: Date) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function isPolicyWorkday(date: Date, workDays: number[]) {
  const jsDay = date.getDay();
  const isoDay = jsDay === 0 ? 7 : jsDay;
  return workDays.includes(isoDay);
}

function overlaps(date: string, from: string, to: string) {
  return date >= from && date <= to;
}

function countStandardDays(workDays: number[], holidays: HolidayConfig[]) {
  const { year, month } = monthBounds();
  const days = new Date(year, month + 1, 0).getDate();
  let count = 0;
  for (let day = 1; day <= days; day += 1) {
    const date = new Date(year, month, day);
    const iso = dateOnly(date);
    if (!isPolicyWorkday(date, workDays)) continue;
    if (holidays.some((holiday) => holiday.active !== false && overlaps(iso, holiday.from_date, holiday.to_date))) continue;
    count += 1;
  }
  return count;
}

function countAnnualLeaveDays(requests: LeaveRequest[], workDays: number[], holidays: HolidayConfig[]) {
  const { year, month } = monthBounds();
  const days = new Date(year, month + 1, 0).getDate();
  let count = 0;
  for (let day = 1; day <= days; day += 1) {
    const date = new Date(year, month, day);
    const iso = dateOnly(date);
    if (!isPolicyWorkday(date, workDays)) continue;
    if (holidays.some((holiday) => holiday.active !== false && overlaps(iso, holiday.from_date, holiday.to_date))) continue;
    if (requests.some((request) => request.status === 'Approved' && request.request_type === 'ANNUAL_LEAVE' && overlaps(iso, request.from_date, request.to_date))) {
      count += 1;
    }
  }
  return count;
}

type WorkHoursConfig = Partial<Pick<SystemConfig, 'MIN_HOURS_FULL' | 'MIN_HOURS_HALF' | 'LUNCH_START' | 'LUNCH_END'>>;
interface ClientConfig { workHours: WorkHoursConfig; approvalRoles: ApprovalRoleConfig; }

// The server-side attendance math reads these from public.config_system; the browser
// must hydrate the same keys so client-side estimates (e.g. History work-day credit)
// match the canonical calculation instead of the frozen module defaults.
function clientConfigFrom(metadata: DataRow): ClientConfig {
  const rows = Array.isArray(metadata.system_settings) ? metadata.system_settings as DataRow[] : [];
  const settings = new Map(rows.map((row) => [textValue(row.key), textValue(row.value)]));
  const workHours: WorkHoursConfig = {};
  const minFull = Number(settings.get('MIN_HOURS_FULL'));
  if (Number.isFinite(minFull) && minFull > 0) workHours.MIN_HOURS_FULL = minFull;
  const minHalf = Number(settings.get('MIN_HOURS_HALF'));
  if (Number.isFinite(minHalf) && minHalf > 0) workHours.MIN_HOURS_HALF = minHalf;
  const lunchStart = settings.get('LUNCH_START');
  if (lunchStart && /^\d{1,2}:\d{2}/.test(lunchStart)) workHours.LUNCH_START = lunchStart.slice(0, 5);
  const lunchEnd = settings.get('LUNCH_END');
  if (lunchEnd && /^\d{1,2}:\d{2}/.test(lunchEnd)) workHours.LUNCH_END = lunchEnd.slice(0, 5);
  return { workHours, approvalRoles: normalizeApprovalRoles(settings.get(APPROVAL_CONFIG_KEY) ?? null) };
}

function shiftDate(date: string, days: number) {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function configFrom(policy: DataRow, locations: LocationConfig[], workHours: WorkHoursConfig = {}): SystemConfig {
  const workDays = Array.isArray(policy.work_days)
    ? policy.work_days.map(Number).filter(Number.isFinite)
    : [1, 2, 3, 4, 5];
  const offDays = [0, 1, 2, 3, 4, 5, 6].filter((day) => !workDays.includes(day === 0 ? 7 : day));
  const maxDistance = locations.reduce((max, location) => Math.max(max, location.radius_meters || 0), TMS_LIMITS.DEFAULT_GEOFENCE_METERS);
  return {
    ...TMS_DEFAULT_SYSTEM_CONFIG,
    ...workHours,
    OFF_DAYS: offDays,
    LATE_TOLERANCE: numberValue(policy.late_tolerance_minutes, TMS_DEFAULT_SYSTEM_CONFIG.LATE_TOLERANCE),
    MAX_DISTANCE_METERS: maxDistance,
  };
}

export function determineShift(timeStr: string, shifts: ShiftConfig[]): ShiftConfig {
  const fallback: ShiftConfig = { ...TMS_DEFAULT_SHIFTS[0] };
  if (!shifts.length) return fallback;

  const sorted = [...shifts].sort((a, b) => timeToMinutes(a.start) - timeToMinutes(b.start));
  const current = timeToMinutes(timeStr);
  const firstShift = sorted[0] ?? fallback;

  // A night shift can finish after midnight. Resolve that carried-over window
  // before treating an early-morning time as "before the first shift".
  const carriedOverShift = sorted.find((shift) => {
    const start = timeToMinutes(shift.start);
    const boundary = timeToMinutes(shift.break_point || shift.end);
    return boundary < start && current <= boundary;
  });
  if (carriedOverShift) return carriedOverShift;

  // When two configured shifts meet at the same minute, that minute belongs
  // to the shift that starts now, not to the preceding shift that just ended.
  const startingShift = sorted.find((shift) => timeToMinutes(shift.start) === current);
  if (startingShift) return startingShift;

  if (current < timeToMinutes(firstShift.start)) return firstShift;

  for (const shift of sorted) {
    let boundary = timeToMinutes(shift.break_point || shift.end);
    const start = timeToMinutes(shift.start);
    if (boundary < start) boundary += 1440;
    if (current <= boundary) return shift;
  }
  return sorted[sorted.length - 1] ?? firstShift;
}

interface DashboardQueryOptions {
  force?: boolean;
  organizationId?: string;
}

export async function getDashboardData(
  employeeId: string,
  options: DashboardQueryOptions = {},
): Promise<{ success: boolean; data?: DashboardData; message?: string }> {
  const startedAt = performance.now();
  try {
    if (!isSupabaseConfigured) throw new Error('Chưa cấu hình Supabase. Vui lòng kiểm tra biến môi trường.');

    const requestedScope = options.organizationId?.trim() && employeeId.trim()
      ? `${options.organizationId.trim()}:${employeeId.trim()}`
      : undefined;
    const bootstrap = await queryWorkforce('bootstrap', {}, {
      scope: requestedScope,
      force: options.force,
      ttlSeconds: Math.ceil(TMS_LIMITS.DASHBOARD_VISIBLE_STALE_MS / 1_000),
    });
    const profileRow = bootstrap.profile && typeof bootstrap.profile === 'object' ? bootstrap.profile as DataRow : {};
    const profile = profileFrom(profileRow);
    if (!profile.employee_id) throw new Error('Không tìm thấy hồ sơ nhân viên.');
    const scope = `${profile.organization_id || 'unassigned'}:${profile.employee_id}`;
    const localDate = textValue(bootstrap.local_date, dateOnly(new Date()));
    const historyFrom = shiftDate(localDate, -TMS_LIMITS.EMPLOYEE_HISTORY_LOOKBACK_DAYS);
    const capabilities = Array.isArray(bootstrap.capabilities)
      ? bootstrap.capabilities.filter((item): item is string => typeof item === 'string')
      : [];
    const canReviewTeamRequests = capabilities.includes('team.read')
      && capabilities.includes('attendance.review');
    const [metadata, historyRows, myRows, teamRowsRaw, directoryRows] = await Promise.all([
      queryWorkforce('metadata', {}, {
        scope,
        force: options.force,
        ttlSeconds: TMS_LIMITS.RESOURCE_CACHE_MAX_SECONDS,
      }),
      queryWorkforceRows('history', { from: historyFrom, to: localDate }, { scope, force: options.force }),
      queryWorkforceRows('requests', { team: false }, { scope, force: options.force }),
      canReviewTeamRequests
        ? queryWorkforceRows('requests', { team: true }, { scope, force: options.force })
        : Promise.resolve([] as DataRow[]),
      queryWorkforceRows('directory', {}, { scope, force: options.force }),
    ]);
    const { workHours, approvalRoles } = clientConfigFrom(metadata);
    const timezone = textValue(bootstrap.timezone, TMS_TIME.ZONE);
    const policy = bootstrap.policy && typeof bootstrap.policy === 'object' ? bootstrap.policy as DataRow : {};

    const shifts = (Array.isArray(metadata.shifts) ? metadata.shifts : []).map((row) => mapShift(row as DataRow));
    const locations = (Array.isArray(metadata.locations) ? metadata.locations : []).map((row) => mapLocation(row as DataRow));
    const locationDirectory = (Array.isArray(metadata.location_directory) ? metadata.location_directory : [])
      .map((row) => mapLocationLabel(row as DataRow));
    const holidays = (Array.isArray(metadata.holidays) ? metadata.holidays : []).map((row) => mapHoliday(row as DataRow));
    const directoryPeople = mapDirectoryPeople(directoryRows);
    const contacts = directoryRows.map((row) => mapContact(row, directoryPeople));
    const history = historyRows.map((row) => mapTimesheet(row, profile, shifts, textValue(policy.name), timezone));

    const teamRows = teamRowsRaw.filter((row) => textValue(row.employee_id) !== profile.employee_id);
    const myRequests = myRows.map(mapLeave).filter((item): item is LeaveRequest => Boolean(item));
    const myExplanations = myRows.map(mapExplanation).filter((item): item is Explanation => Boolean(item));
    const teamRequests = teamRows.map(mapLeave).filter((item): item is LeaveRequest => Boolean(item));
    const teamExplanations = teamRows.map(mapExplanation).filter((item): item is Explanation => Boolean(item));

    const policyWorkDays = Array.isArray(policy.work_days)
      ? policy.work_days.map(Number).filter(Number.isFinite)
      : [1, 2, 3, 4, 5];
    const workforceSummary = bootstrap.summary && typeof bootstrap.summary === 'object' ? bootstrap.summary as DataRow : {};
    const monthKey = monthBounds().key;
    const summary = {
      workDays: numberValue(workforceSummary.days),
      lateMins: history.filter((row) => row.date.startsWith(monthKey)).reduce((sum, row) => sum + row.late_minutes, 0),
      leaveDays: countAnnualLeaveDays(myRequests, policyWorkDays, holidays),
      remainingLeave: numberValue(workforceSummary.remaining_leave, numberValue(profile.annual_leave_balance)),
      standardDays: countStandardDays(policyWorkDays, holidays),
      errorCount: numberValue(workforceSummary.exceptions),
    };

    const result = {
      success: true,
      data: {
        userProfile: profile,
        history: { history, summary },
        notifications: {
          approvals: teamRequests.filter((request) => request.status === 'Pending'),
          explanationApprovals: teamExplanations.filter((request) => request.status === 'Pending'),
          myRequests,
          myExplanations,
        },
        myRequests,
        myExplanations,
        teamLeaves: teamRequests.filter((request) => request.status === 'Pending' || request.status === 'Approved'),
        locations,
        locationDirectory,
        contacts,
        holidays,
        shifts,
        systemConfig: configFrom(policy, locations, workHours),
        approvalRoles,
        capabilities,
        organizationTimezone: timezone,
        serverLocalDate: localDate,
        serverTime: optionalText(bootstrap.server_time),
      },
    };
    void reportClientMetric('DASHBOARD_LOAD_OK', performance.now() - startedAt, 'LOAD');
    return result;
  } catch (error) {
    void reportClientMetric('DASHBOARD_LOAD_FAILED', performance.now() - startedAt, 'LOAD');
    return { success: false, message: errorMessage(error, 'Không tải được dữ liệu.') };
  }
}

interface SubmitRequestInput {
  type: string;
  fromDate: string;
  toDate: string;
  reason: string;
  clientRequestId: string;
}

export interface SubmitExplanationInput {
  date: string;
  reason: string;
  requestType?: 'EXPLANATION' | 'CORRECTION';
  requestedCheckin?: string;
  requestedCheckout?: string;
  clientRequestId: string;
}

const CLOCK_VALUE_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function addCalendarDay(date: string) {
  const [year, month, day] = date.split('-').map(Number);
  const value = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, (day ?? 1) + 1));
  return value.toISOString().slice(0, 10);
}

export function attendanceRequestPayload(input: SubmitExplanationInput) {
  const requestType = input.requestType ?? 'EXPLANATION';
  const payload: Record<string, string> = {
    request_type: requestType,
    from_date: input.date,
    to_date: input.date,
    reason: input.reason,
    client_request_id: input.clientRequestId,
  };
  if (requestType === 'EXPLANATION') return payload;

  const checkin = input.requestedCheckin?.trim() ?? '';
  const checkout = input.requestedCheckout?.trim() ?? '';
  if (!CLOCK_VALUE_PATTERN.test(checkin) || !CLOCK_VALUE_PATTERN.test(checkout)) {
    throw new Error('Điều chỉnh công cần đủ giờ check-in và check-out hợp lệ.');
  }
  const checkinMinutes = timeToMinutes(checkin);
  const checkoutMinutes = timeToMinutes(checkout);
  const checkoutDate = checkoutMinutes <= checkinMinutes ? addCalendarDay(input.date) : input.date;
  payload.requested_checkin = `${input.date}T${checkin}:00${TMS_TIME.UTC_OFFSET}`;
  payload.requested_checkout = `${checkoutDate}T${checkout}:00${TMS_TIME.UTC_OFFSET}`;
  return payload;
}

/** Generate once when a request form opens, then reuse for every retry. */
export function requestCommandId() {
  return commandId();
}

export async function submitRequest(input: SubmitRequestInput) {
  try {
    const { data, error } = await supabase.rpc('workforce_command', {
      p_action: 'request.submit',
      p_args: {
        request_type: requestCode(input.type),
        from_date: input.fromDate,
        to_date: input.toDate,
        reason: input.reason,
        client_request_id: input.clientRequestId,
      },
    });
    if (error) throw error;
    if (!data || typeof data !== 'object' || (data as DataRow).ok !== true) throw new Error('Không gửi được đề xuất.');
    return ok('Gửi đề xuất thành công!');
  } catch (error) {
    return err(error);
  }
}

export async function submitExplanation(input: SubmitExplanationInput) {
  try {
    const { data, error } = await supabase.rpc('workforce_command', {
      p_action: 'request.submit',
      p_args: attendanceRequestPayload(input),
    });
    if (error) throw error;
    if (!data || typeof data !== 'object' || (data as DataRow).ok !== true) throw new Error('Không gửi được giải trình.');
    return ok('Gửi giải trình thành công!');
  } catch (error) {
    return err(error);
  }
}

async function requestRevision(id: string) {
  const data = await queryWorkforce('request.detail', { id }, { force: true });
  const row = data.row && typeof data.row === 'object' ? data.row as DataRow : null;
  if (!row) throw new Error('Đề xuất không còn tồn tại hoặc ngoài phạm vi của bạn.');
  return numberValue(row.revision, 0);
}

async function cancelRequest(id: string) {
  const revision = await requestRevision(id);
  const { data, error } = await supabase.rpc('workforce_command', {
    p_action: 'request.cancel',
    p_args: { id, revision },
  });
  if (error) throw error;
  if (!data || typeof data !== 'object' || (data as DataRow).ok !== true) throw new Error('Không thu hồi được đề xuất.');
}

export async function deleteRequest(id: string) {
  try {
    await cancelRequest(id);
    return ok('Đã thu hồi đề xuất!');
  } catch (error) {
    return err(error);
  }
}

export async function deleteExplanation(id: string) {
  try {
    await cancelRequest(id);
    return ok('Đã thu hồi giải trình!');
  } catch (error) {
    return err(error);
  }
}

async function reviewRequest(id: string, status: DecisionStatus, note: string) {
  const revision = await requestRevision(id);
  const decision = status === 'Approved' ? 'APPROVED' : 'REJECTED';
  const { data, error } = await supabase.rpc('workforce_command', {
    p_action: 'request.review',
    p_args: { id, revision, decision, note },
  });
  if (error) throw error;
  if (!data || typeof data !== 'object' || (data as DataRow).ok !== true) throw new Error('Không xử lý được đề xuất.');
}

export async function processRequest(id: string, status: DecisionStatus, note: string) {
  try {
    await reviewRequest(id, status, note);
    return ok('Đã xử lý!');
  } catch (error) {
    return err(error);
  }
}

export async function processExplanation(id: string, status: DecisionStatus, note: string) {
  try {
    await reviewRequest(id, status, note);
    return ok('Đã xử lý!');
  } catch (error) {
    return err(error);
  }
}

function requestCurrentPosition() {
  return new Promise<GeolocationPosition>((resolve, reject) => {
    if (!('geolocation' in navigator)) return reject(new Error('Thiết bị không hỗ trợ định vị.'));
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: TMS_LIMITS.GPS_TIMEOUT_MS,
      maximumAge: 0,
    });
  });
}

export async function doCheckOut(position: { lat: number; lng: number; accuracy: number }) {
  try {
    assertValidAttendancePosition(position);
    const result = await runAttendanceAction('checkout', position);
    return { ...ok(result.message || 'Check-out thành công!'), receipt: result.receipt };
  } catch (error) {
    return err(error);
  }
}

export async function togglePause() {
  try {
    const [{ data: bootstrap, error: bootstrapError }, position] = await Promise.all([
      supabase.rpc('workforce_query', { p_resource: 'bootstrap', p_args: {} }),
      requestCurrentPosition(),
    ]);
    if (bootstrapError) throw bootstrapError;
    if (!bootstrap || typeof bootstrap !== 'object') throw new Error('Không đọc được trạng thái ca làm việc.');
    const today = (bootstrap as DataRow).today;
    if (!today || typeof today !== 'object') throw new Error('Không có ca đang mở.');
    const timesheet = today as DataRow;
    if (!optionalText(timesheet.actual_checkin) || optionalText(timesheet.actual_checkout)) throw new Error('Không có ca đang làm việc.');
    const action = optionalText(timesheet.break_started_at) ? 'resume' : 'pause';
    const result = await runAttendanceAction(action, {
      lat: position.coords.latitude,
      lng: position.coords.longitude,
      accuracy: position.coords.accuracy,
    });
    return {
      success: true as const,
      message: action === 'pause' ? 'Đã bắt đầu tạm dừng.' : 'Đã tiếp tục làm việc.',
      action,
      receipt: result.receipt,
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
    if (separatorIndex < 0 || !header.startsWith('data:') || !header.endsWith(';base64') || !payload) throw new Error('Invalid data URL');
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
    if (avatar.size > TMS_LIMITS.MAX_AVATAR_STORAGE_BYTES) throw new Error('Ảnh sau khi xử lý vẫn vượt quá dung lượng lưu trữ.');

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
    // The password is already replaced at this point, so a failure to clear the
    // reminder must not be reported as a failed change. The prompt is dismissible
    // and reappears at worst on the next sign-in.
    const { error: reminderError } = await supabase.rpc('acknowledge_password_change');
    if (reminderError) console.warn('Unable to clear the password change reminder:', reminderError);
    return ok('Đổi mật khẩu thành công.');
  } catch (error) {
    return err(error);
  }
}
