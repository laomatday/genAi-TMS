export type EmployeeRole = 'Staff' | 'Leader' | 'Manager' | 'Director' | 'Admin' | 'HR' | 'Kiosk';
export type ReviewStatus = 'Pending' | 'Approved' | 'Rejected';
export type WorkforceRequestType =
  | 'EXPLANATION'
  | 'CORRECTION'
  | 'ANNUAL_LEAVE'
  | 'SICK_LEAVE'
  | 'UNPAID_LEAVE'
  | 'BUSINESS_TRIP'
  | 'REMOTE_WORK'
  | 'SHIFT_SWAP'
  | 'OVERTIME';

export interface Employee {
  id: string;
  employee_id: string;
  uid?: string;
  auth_user_id?: string;
  organization_id?: string;
  name: string;
  email: string;
  phone?: string | number;
  role: EmployeeRole;
  center_id: string;
  attendance_policy_id?: string | null;
  allowed_locations?: string[];
  managed_locations?: string[];
  direct_manager_id?: string | null;
  annual_leave_balance?: number;
  trusted_device_id?: string | null;
  trusted_device_bound_at?: string | null;
  /** True while the account still uses the default password issued at provisioning. */
  password_change_required?: boolean;
  /** Per-employee device lock override. Null follows the role policy. */
  device_lock_required?: boolean | null;
  /** Per-employee capability overrides. An absent key follows the role. */
  capability_overrides?: Record<string, boolean>;
  position?: string;
  department?: string;
  avatar_url?: string;
  face_ref_url?: string;
  join_date?: string;
  employment_start_date?: string | null;
  employment_end_date?: string | null;
  fcm_tokens?: string[];
  status: 'Active' | 'Inactive';
}

export interface Attendance {
  id: string;
  date: string;
  employee_id: string;
  name: string;
  center_id: string;
  location_name?: string;
  shift_name?: string;
  shift_start?: string;
  shift_end?: string;
  time_in: string;
  time_out: string;
  checkin_type: 'QR_GPS' | 'GPS' | 'Manual' | 'Mobile' | 'Kiosk';
  checkin_lat: number;
  checkin_lng: number;
  distance_meters: number;
  location_accuracy_m?: number;
  checkout_lat?: number;
  checkout_lng?: number;
  checkout_distance?: number;
  checkout_accuracy_m?: number;
  qr_station_id?: string;
  device_id?: string;
  selfie_url?: string;
  late_minutes: number;
  early_minutes: number;
  work_hours: number;
  status: 'Valid' | 'Late' | 'Invalid';
  is_valid: 'Yes' | 'No';
  note: string;
  timestamp: number;
  last_updated?: string;
  break_start?: string;
  total_break_mins?: number;
}

export interface LeaveRequest {
  id: string;
  request_id?: string;
  request_code?: string;
  employee_id: string;
  name?: string;
  created_at: string;
  type: 'Nghỉ phép' | 'Nghỉ ốm' | 'Nghỉ không lương' | 'Công tác' | 'Làm việc tại nhà' | 'WFH' | string;
  request_type?: WorkforceRequestType;
  from_date: string;
  to_date: string;
  expiration_date?: string;
  reason: string;
  status: ReviewStatus;
  note?: string;
  manager_note?: string;
  approver_id?: string | null;
  assigned_to?: string | null;
  fallback_to?: string | null;
  due_at?: string;
  revision?: number;
  workflow_data?: Record<string, unknown>;
  updated_at?: string;
}

export interface Explanation {
  id: string;
  request_code?: string;
  employee_id: string;
  name?: string;
  date: string;
  attendance_date?: string;
  reason: string;
  status: ReviewStatus;
  request_type?: 'EXPLANATION' | 'CORRECTION';
  assigned_to?: string | null;
  requested_checkin?: string | null;
  requested_checkout?: string | null;
  manager_note?: string;
  approver_id?: string | null;
  revision?: number;
  updated_at?: string;
  created_at: string;
}

export interface ExplainableAttendanceItem {
  date: string;
  explainReason: string;
  missingCheckin: boolean;
  missingCheckout: boolean;
  recordedCheckin?: string;
  recordedCheckout?: string;
}

export interface LocationConfig {
  id?: string;
  center_id: string;
  location_name: string;
  center_name?: string;
  address?: string;
  city?: string;
  latitude: number;
  longitude: number;
  radius_meters: number;
  active?: boolean;
}
export type Location = Omit<LocationConfig, 'location_name' | 'center_name' | 'active'> & { center_name: string; location_name?: string; active: boolean };

/** Label-only branch registry. Covers every branch of the organization, including
 *  inactive ones and branches outside the viewer's geofence scope, so any center_id
 *  coming back from the directory or a timesheet can be rendered as a name. */
export interface LocationLabel {
  center_id: string;
  center_name: string;
  city?: string;
  active: boolean;
}

export interface ShiftConfig { name: string; start: string; end: string; break_point?: string; }

export interface HolidayConfig { id?: number; name: string; from_date: string; to_date: string; paid?: boolean; active?: boolean; }

export interface SystemConfig {
  LATE_TOLERANCE: number;
  MIN_HOURS_FULL: number;
  MIN_HOURS_HALF: number;
  LUNCH_START: string;
  LUNCH_END: string;
  OFF_DAYS: number[];
  MAX_DISTANCE_METERS: number;
  LOCK_DATE?: number;
  MAX_EXPLANATIONS_PER_MONTH?: number;
  QR_REFRESH_SECONDS?: number;
  QR_VALIDITY_SECONDS?: number;
}

export interface DashboardData {
  organizationTimezone?: string;
  serverLocalDate?: string;
  serverTime?: string;
  userProfile: Employee;
  history: {
    history: Attendance[];
    summary: { workDays: number; lateMins: number; leaveDays: number; remainingLeave: number; standardDays: number; errorCount: number; };
  };
  notifications: {
    approvals: LeaveRequest[];
    explanationApprovals: Explanation[];
    myRequests: LeaveRequest[];
    myExplanations: Explanation[];
  };
  myRequests: LeaveRequest[];
  myExplanations: Explanation[];
  teamLeaves: LeaveRequest[];
  locations: LocationConfig[];
  locationDirectory: LocationLabel[];
  contacts: Employee[];
  holidays: HolidayConfig[];
  shifts: ShiftConfig[];
  systemConfig: SystemConfig;
  approvalRoles: { leave: EmployeeRole[]; attendance: EmployeeRole[] };
  capabilities: string[];
}

export interface WorkforceReceipt {
  id: string;
  event_id?: string;
  action: 'checkin' | 'checkout' | 'pause' | 'resume';
  occurred_at: string;
  work_date: string;
  location_name?: string;
  gps_accuracy_m?: number;
  device_verified?: boolean;
  timesheet_id?: string;
  work_session_id?: string;
  status?: string;
}

export interface WorkforceAttendanceResult {
  ok: boolean;
  code?: string;
  message?: string;
  receipt?: WorkforceReceipt;
}

export interface DynamicQrResult { payload: string; expiresAt: number; branchName: string; }
