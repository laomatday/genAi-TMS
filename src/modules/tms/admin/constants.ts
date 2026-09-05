import type { EmployeeRole, SystemConfig } from '@/shared/types';
import { TMS_DEFAULT_POLICY, TMS_DEFAULT_SYSTEM_CONFIG, TMS_DEFAULTS, TMS_LIMITS } from '@/shared/constants';
import type { AttendancePolicy, HolidayRecord, ShiftRecord, TimesheetStatus, TmsLocation } from './types';
import type { EmployeeInput } from './adminService';

export type AdminSection = 'overview' | 'accounts' | 'scheduling' | 'attendance' | 'settings' | 'kiosks' | 'audit';
export type AttendanceFilter = 'all' | 'action' | 'approved' | 'locked';
export type SettingsSection = 'policies' | 'shifts' | 'system' | 'holidays' | 'locations';

export interface AdminCapability {
  manageAccounts: boolean;
  manageSchedules: boolean;
  manageSettings: boolean;
  reviewAttendance: boolean;
  lockAttendance: boolean;
  manageKiosks: boolean;
  viewAudit: boolean;
}

export const ADMIN_NAV: ReadonlyArray<{ id: AdminSection; icon: string; label: string }> = [
  { id: 'overview', icon: 'space_dashboard', label: 'Tổng quan' },
  { id: 'accounts', icon: 'manage_accounts', label: 'Tài khoản' },
  { id: 'scheduling', icon: 'calendar_month', label: 'Phân ca' },
  { id: 'attendance', icon: 'fact_check', label: 'Chấm công' },
  { id: 'settings', icon: 'tune', label: 'Tham số hệ thống' },
  { id: 'kiosks', icon: 'qr_code_2', label: 'Kiosk' },
  { id: 'audit', icon: 'history', label: 'Nhật ký' },
];

export const ATTENDANCE_STATUS_LABELS: Record<TimesheetStatus, string> = {
  SCHEDULED: 'Đã xếp lịch',
  OPEN: 'Đang làm',
  COMPLETE: 'Hoàn tất',
  AUTO_APPROVED: 'Tự động duyệt',
  EXCEPTION: 'Cần xử lý',
  PENDING_REVIEW: 'Chờ duyệt',
  APPROVED: 'Đã duyệt',
  REJECTED: 'Bị từ chối',
  LOCKED: 'Đã khóa',
  CANCELLED: 'Đã hủy',
};

export const EXCEPTION_LABELS: Record<string, string> = {
  MISSING_CHECKIN: 'Thiếu check-in',
  MISSING_CHECKOUT: 'Thiếu check-out',
  LATE: 'Đi trễ',
  EARLY_LEAVE: 'Về sớm',
  UNSCHEDULED_DAY: 'Ngoài lịch làm',
  OUTSIDE_CHECKIN_WINDOW: 'Ngoài giờ check-in',
  OUTSIDE_CHECKOUT_WINDOW: 'Ngoài giờ check-out',
  INVALID_LEGACY: 'Dữ liệu cũ không hợp lệ',
  HOLIDAY: 'Ngày nghỉ lễ',
  APPROVED_LEAVE: 'Nghỉ đã duyệt',
};

export const WEEKDAYS = [
  { value: 1, label: 'T2' },
  { value: 2, label: 'T3' },
  { value: 3, label: 'T4' },
  { value: 4, label: 'T5' },
  { value: 5, label: 'T6' },
  { value: 6, label: 'T7' },
  { value: 7, label: 'CN' },
] as const;

export const DEFAULT_ATTENDANCE_POLICY: AttendancePolicy = {
  id: '',
  name: '',
  work_days: [...TMS_DEFAULT_POLICY.WORK_DAYS],
  expected_start: TMS_DEFAULT_POLICY.EXPECTED_START,
  expected_end: TMS_DEFAULT_POLICY.EXPECTED_END,
  late_tolerance_minutes: TMS_DEFAULT_POLICY.LATE_TOLERANCE_MINUTES,
  early_tolerance_minutes: TMS_DEFAULT_POLICY.EARLY_TOLERANCE_MINUTES,
  checkin_window_start: TMS_DEFAULT_POLICY.CHECKIN_WINDOW_START,
  checkin_window_end: TMS_DEFAULT_POLICY.CHECKIN_WINDOW_END,
  checkout_window_start: TMS_DEFAULT_POLICY.CHECKOUT_WINDOW_START,
  checkout_window_end: TMS_DEFAULT_POLICY.CHECKOUT_WINDOW_END,
  gps_good_accuracy_m: TMS_LIMITS.GOOD_GPS_ACCURACY_METERS,
  gps_max_accuracy_m: TMS_LIMITS.MAX_GPS_ACCURACY_METERS,
  unpaid_break_minutes: TMS_DEFAULT_POLICY.UNPAID_BREAK_MINUTES,
  auto_approve: true,
  active: true,
};

export const DEFAULT_LOCATION: TmsLocation = {
  center_id: '',
  center_name: '',
  address: '',
  city: '',
  latitude: 0,
  longitude: 0,
  radius_meters: TMS_LIMITS.DEFAULT_GEOFENCE_METERS,
  active: true,
};

export const DEFAULT_EMPLOYEE: EmployeeInput = {
  employee_id: '',
  name: '',
  email: '',
  phone: '',
  role: 'Staff',
  center_id: '',
  allowed_locations: [],
  managed_locations: [],
  direct_manager_id: null,
  annual_leave_balance: TMS_DEFAULTS.ANNUAL_LEAVE_DAYS,
  attendance_policy_id: null,
  position: '',
  department: '',
  status: 'Active',
  password: '',
};

export const DEFAULT_SHIFT: ShiftRecord = {
  name: '',
  start_time: '08:30',
  end_time: '17:30',
  break_point: '17:30',
  sort_order: 10,
  active: true,
};

export const DEFAULT_HOLIDAY: HolidayRecord = {
  name: '',
  from_date: '',
  to_date: '',
  paid: true,
  active: true,
};

export const DEFAULT_SYSTEM_SETTINGS: SystemConfig = {
  ...TMS_DEFAULT_SYSTEM_CONFIG,
  OFF_DAYS: [...TMS_DEFAULT_SYSTEM_CONFIG.OFF_DAYS],
};

export function getAdminCapabilities(role: EmployeeRole): AdminCapability {
  const isAdmin = role === 'Admin';
  const isAttendanceOperator = isAdmin || role === 'HR' || role === 'Director';
  return {
    manageAccounts: isAdmin,
    manageSchedules: isAttendanceOperator,
    manageSettings: isAttendanceOperator,
    reviewAttendance: isAttendanceOperator,
    lockAttendance: isAttendanceOperator,
    manageKiosks: isAdmin,
    viewAudit: isAttendanceOperator,
  };
}
