import type { Employee } from '@/shared/types';

export type TimesheetStatus =
  | 'OPEN'
  | 'COMPLETE'
  | 'AUTO_APPROVED'
  | 'EXCEPTION'
  | 'PENDING_REVIEW'
  | 'APPROVED'
  | 'REJECTED'
  | 'LOCKED';

type AttendanceRequestType = 'EXPLANATION' | 'CORRECTION';
type AttendanceRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface AttendancePolicy {
  id: string;
  name: string;
  work_days: number[];
  expected_start: string;
  expected_end: string;
  late_tolerance_minutes: number;
  early_tolerance_minutes: number;
  checkin_window_start: string;
  checkin_window_end: string;
  checkout_window_start: string;
  checkout_window_end: string;
  gps_good_accuracy_m: number;
  gps_max_accuracy_m: number;
  unpaid_break_minutes: number;
  auto_approve: boolean;
  active: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface TmsLocation {
  center_id: string;
  center_name: string;
  address?: string | null;
  city?: string | null;
  latitude: number;
  longitude: number;
  radius_meters: number;
  active: boolean;
}

export interface Timesheet {
  id: string;
  employee_id: string;
  work_date: string;
  policy_id?: string | null;
  location_id?: string | null;
  expected_start?: string | null;
  expected_end?: string | null;
  actual_checkin?: string | null;
  actual_checkout?: string | null;
  status: TimesheetStatus;
  source: 'NORMAL' | 'ADJUSTED' | 'LEGACY';
  exception_codes: string[];
  late_minutes: number;
  early_minutes: number;
  work_minutes: number;
  locked_at?: string | null;
  locked_by?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface AttendanceRequest {
  id: string;
  timesheet_id: string;
  employee_id: string;
  request_type: AttendanceRequestType;
  exception_code?: string | null;
  requested_checkin?: string | null;
  requested_checkout?: string | null;
  reason: string;
  status: AttendanceRequestStatus;
  manager_note?: string | null;
  approver_id?: string | null;
  created_at: string;
  updated_at?: string;
  work_date?: string;
  origin?: 'timesheet' | 'legacy';
}

export interface TrustedDeviceInfo {
  device_id: string;
  employee_id?: string;
  device_label?: string | null;
  user_agent?: string | null;
  status?: 'ACTIVE' | 'REVOKED';
  activated_at?: string | null;
  last_seen_at?: string | null;
}

export interface QrStationInfo {
  id: string;
  station_user_id: string;
  center_id: string;
  name: string;
  active: boolean;
  created_by?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface ShiftRecord {
  id?: number;
  name: string;
  start_time: string;
  end_time: string;
  break_point: string;
  sort_order: number;
  active: boolean;
}

export interface ShiftAssignment {
  id: string;
  employee_id: string;
  work_date: string;
  shift_id: number;
  location_id?: string | null;
  note: string;
  created_by?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface AttendancePeriod {
  id: string;
  period_start: string;
  period_end: string;
  status: 'CLOSED' | 'REOPENED';
  closed_by: string;
  closed_at: string;
  note: string;
  reopened_by?: string | null;
  reopened_at?: string | null;
  reopen_reason?: string | null;
}

export interface SystemSetting {
  key: string;
  value: string;
  updated_at?: string;
}

export interface HolidayRecord {
  id?: number;
  name: string;
  from_date: string;
  to_date: string;
  paid: boolean;
  active: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface AuditLogInfo {
  id: string;
  actor_employee_id?: string | null;
  target_employee_id?: string | null;
  action: string;
  entity_type?: string | null;
  entity_id?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown>;
  created_at: string;
}

export interface AdminData {
  employees: Employee[];
  locations: TmsLocation[];
  policies: AttendancePolicy[];
  timesheets: Timesheet[];
  requests: AttendanceRequest[];
  monthlyRequests?: AttendanceRequest[];
  stations: QrStationInfo[];
  devices: TrustedDeviceInfo[];
  shifts: ShiftRecord[];
  shiftAssignments: ShiftAssignment[];
  attendancePeriods: AttendancePeriod[];
  systemSettings: SystemSetting[];
  holidays: HolidayRecord[];
  auditLogs: AuditLogInfo[];
  features: {
    workforceOperations: boolean;
  };
}

export interface AttendanceRange {
  from: string;
  to: string;
}

export type AdminActionRunner = (
  task: () => Promise<unknown>,
  successMessage: string,
  options?: { refresh?: boolean },
) => Promise<boolean>;
