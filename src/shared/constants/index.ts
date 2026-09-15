import type { Employee, EmployeeRole, ShiftConfig, SystemConfig } from '@/shared/types';

const ENV_DOMAIN = typeof import.meta !== 'undefined' && import.meta.env?.VITE_APP_DOMAIN ? import.meta.env.VITE_APP_DOMAIN : 'genai.ai.vn';
const ENV_BRAND = typeof import.meta !== 'undefined' && import.meta.env?.VITE_APP_BRAND ? import.meta.env.VITE_APP_BRAND : 'genAi';
const ENV_LOGO_URL = typeof import.meta !== 'undefined' && import.meta.env?.VITE_APP_LOGO_URL ? import.meta.env.VITE_APP_LOGO_URL : '/genai-symbol.svg';
const ENV_SUPPORT_EMAIL = typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPPORT_EMAIL ? import.meta.env.VITE_SUPPORT_EMAIL : `support@${ENV_DOMAIN}`;
const ENV_PHONE = typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPPORT_PHONE ? import.meta.env.VITE_SUPPORT_PHONE : '19001234';
const ENV_PHONE_LABEL = typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPPORT_PHONE_LABEL ? import.meta.env.VITE_SUPPORT_PHONE_LABEL : '1900 1234 (Nhánh 1)';
const ENV_LOGIN_DOMAINS = typeof import.meta !== 'undefined' && import.meta.env?.VITE_LOGIN_EMAIL_DOMAINS
  ? import.meta.env.VITE_LOGIN_EMAIL_DOMAINS
  : ENV_DOMAIN;
const ENV_RELEASE_CHANNEL = typeof import.meta !== 'undefined' && import.meta.env?.VITE_RELEASE_CHANNEL ? import.meta.env.VITE_RELEASE_CHANNEL : 'stable';
const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0-dev';
const APP_BUILD_ID = typeof __APP_BUILD_ID__ !== 'undefined' ? __APP_BUILD_ID__ : 'local';

export const APP_INFO = {
  NAME: ENV_BRAND,
  BRAND: ENV_BRAND,
  PRODUCT_NAME: `${ENV_BRAND} TMS`,
  VERSION: APP_VERSION,
  BUILD_ID: APP_BUILD_ID,
  RELEASE_CHANNEL: ENV_RELEASE_CHANNEL,
  DOMAIN: ENV_DOMAIN,
  WEBSITE_URL: `https://${ENV_DOMAIN}`,
  CONTACT_EMAIL: ENV_SUPPORT_EMAIL,
  LOGO_URL: ENV_LOGO_URL,
  SUPPORT_PHONE: ENV_PHONE,
  SUPPORT_PHONE_LABEL: ENV_PHONE_LABEL,
} as const;

export const APP_ROUTES = {
  HOME: '/',
  ATTENDANCE: '/attendance',
  ADMIN: '/admin',
  KIOSK: '/kiosk',
} as const;

export const EMPLOYEE_ROLES: readonly EmployeeRole[] = ['Staff', 'Leader', 'Manager', 'Director', 'HR', 'Admin', 'Kiosk'];
export const MANAGEMENT_ROLES: readonly EmployeeRole[] = ['Leader', 'Manager', 'Director', 'Admin', 'HR'];
// Keep this aligned with both the trusted-device Edge Function and the
// attendance command. Every interactive employee account, including Admin,
// must complete device proof. Dedicated Kiosk operators never self-attend.
export const DEVICE_EXEMPT_ROLES: readonly EmployeeRole[] = ['Kiosk'];

// Which roles may approve which request family. Configurable from Admin →
// Tham số hệ thống → Phân quyền duyệt (stored in config_system as APPROVAL_ROLES).
// Admin is always an approver and is not stored. Leader is excluded by default.
export type ApprovalKind = 'leave' | 'attendance';
export const APPROVAL_KINDS: readonly ApprovalKind[] = ['leave', 'attendance'];
export const APPROVAL_CONFIG_KEY = 'APPROVAL_ROLES';
export const APPROVAL_EDITABLE_ROLES: readonly EmployeeRole[] = ['Leader', 'Manager', 'Director', 'HR'];
export type ApprovalRoleConfig = Record<ApprovalKind, EmployeeRole[]>;
export const DEFAULT_APPROVAL_ROLES: ApprovalRoleConfig = {
  leave: ['Manager', 'Director', 'HR', 'Admin'],
  attendance: ['Manager', 'Director', 'HR', 'Admin'],
};

export function normalizeApprovalRoles(raw: unknown): ApprovalRoleConfig {
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); } catch { parsed = null; }
  }
  const pick = (kind: ApprovalKind): EmployeeRole[] => {
    const list = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>)[kind] : null;
    const roles = Array.isArray(list)
      ? list.filter((role): role is EmployeeRole => APPROVAL_EDITABLE_ROLES.includes(role as EmployeeRole))
      : DEFAULT_APPROVAL_ROLES[kind].filter((role) => role !== 'Admin');
    return [...new Set<EmployeeRole>([...roles, 'Admin'])];
  };
  return { leave: pick('leave'), attendance: pick('attendance') };
}

export function canApprove(role: EmployeeRole, kind: ApprovalKind, config: ApprovalRoleConfig = DEFAULT_APPROVAL_ROLES): boolean {
  return config[kind].includes(role);
}

export function canApproveAny(role: EmployeeRole, config: ApprovalRoleConfig = DEFAULT_APPROVAL_ROLES): boolean {
  return canApprove(role, 'leave', config) || canApprove(role, 'attendance', config);
}

export const STORAGE_KEYS = {
  THEME: 'genai_theme',
  GUIDE_SEEN: 'genai_guide_seen_v2026',
  DEVICE_ID: 'genai_tms_device_id_v2',
  DB_NAME: 'genai-tms-device',
  STORE_NAME: 'keys',
} as const;

export function scopedStorageKey(
  baseKey: string,
  user: Pick<Employee, 'employee_id' | 'organization_id'>,
) {
  const organization = user.organization_id || 'unassigned';
  return `${baseKey}:${encodeURIComponent(organization)}:${encodeURIComponent(user.employee_id)}`;
}

export const ADMIN_BULK_NOTE_PRESETS = {
  APPROVED: [
    'Đã kiểm tra và duyệt theo xác nhận bộ phận',
    'Bổ sung đủ công hợp lệ',
    'Chấp thuận lý do giải trình',
  ],
  REJECTED: [
    'Lý do chưa đủ căn cứ hoặc thiếu minh chứng',
    'Quá thời hạn giải trình theo quy chế',
    'Không khớp với dữ liệu ra vào thực tế',
  ],
} as const;

export const APP_EVENTS = {
  THEME_UPDATED: 'genai_theme_update',
} as const;

export const UI_MOTION = {
  NAVIGATION_SPRING: {
    type: 'spring',
    stiffness: 420,
    damping: 34,
    mass: 0.72,
  },
  PAGE_OFFSET_FORWARD: 'var(--app-page-swipe-forward)',
  PAGE_OFFSET_BACKWARD: 'var(--app-page-swipe-backward)',
  PAGE_TRANSITION: {
    duration: 0.18,
    ease: [0.22, 1, 0.36, 1],
  },
} as const;

export const TMS_TIME = {
  ZONE: 'Asia/Ho_Chi_Minh',
  UTC_OFFSET: '+07:00',
  MAX_CORRECTION_HOURS: 24,
} as const;

export const TMS_LIMITS = {
  DEFAULT_GEOFENCE_METERS: 200 as number,
  GOOD_GPS_ACCURACY_METERS: 50,
  MAX_GPS_ACCURACY_METERS: 150,
  GPS_TIMEOUT_MS: 12_000,
  DASHBOARD_REFRESH_MS: 120_000,
  DASHBOARD_REFRESH_JITTER_RATIO: 0.2,
  DASHBOARD_REFRESH_MAX_BACKOFF_MS: 15 * 60_000,
  DASHBOARD_VISIBLE_STALE_MS: 30_000,
  QR_REFRESH_MS: 30_000,
  QR_VALIDITY_SECONDS: 45,
  QR_SCAN_FPS: 12,
  QR_SCAN_AREA_RATIO: 0.7,
  CHECKOUT_REMINDER_DELAY_MINUTES: 15,
  EARLY_CHECKOUT_WARNING_MINUTES: 5,
  CLOCK_REFRESH_MS: 1_000,
  EXPLANATION_LOOKBACK_DAYS: 45,
  LOCK_DATE: 5,
  MAX_EXPLANATIONS_PER_MONTH: 5,
  REQUEST_REASON_MIN_LENGTH: 5,
  REQUEST_REASON_MAX_LENGTH: 500,
  TOUCH_AXIS_LOCK_PX: 6,
  TOUCH_AXIS_DOMINANCE_RATIO: 1.3,
  SWIPE_NAVIGATION_PX: 44,
  SWIPE_NAVIGATION_VIEWPORT_RATIO: 0.12,
  SWIPE_MODAL_CLOSE_PX: 40,
  SWIPE_MODAL_VIEWPORT_RATIO: 0.11,
  SWIPE_EDGE_START_PX: 48,
  SWIPE_MAX_THRESHOLD_PX: 88,
  SWIPE_MAX_DURATION_MS: 850,
  SWIPE_MIN_VELOCITY_PX_MS: 0.07,
  SWIPE_FLING_VELOCITY_PX_MS: 0.32,
  SWIPE_PROJECTION_MS: 180,
  SWIPE_VELOCITY_LOOKBACK_MS: 100,
  SWIPE_CLICK_SUPPRESSION_MS: 300,
  SWIPE_SETTLE_MS: 220,
  SWIPE_COMMIT_MS: 150,
  SWIPE_LONG_DISTANCE_MULTIPLIER: 1.7,
  PULL_REFRESH_START_PX: 12,
  PULL_REFRESH_TRIGGER_PX: 68,
  PULL_REFRESH_MAX_PX: 120,
  PULL_REFRESH_RESISTANCE: 0.42,
  CONTACT_SEARCH_DEBOUNCE_MS: 300,
  INPUT_FOCUS_DELAY_MS: 150,
  MAX_AVATAR_FILE_BYTES: 10 * 1024 * 1024,
  MAX_AVATAR_STORAGE_BYTES: 2 * 1024 * 1024,
  AVATAR_OUTPUT_PIXELS: 500,
  AVATAR_JPEG_QUALITY: 0.88,
  MAX_SPREADSHEET_FILE_BYTES: 5 * 1024 * 1024,
  MAX_SPREADSHEET_IMPORT_ROWS: 1_000,
  // Account imports call Supabase Auth and Postgres once per employee. Keep the
  // interactive batch deliberately smaller than schedule-only spreadsheets so
  // an interrupted browser session has a bounded reconciliation surface.
  MAX_EMPLOYEE_IMPORT_ROWS: 100,
  ADMIN_FETCH_BATCH_SIZE: 1_000,
  RESOURCE_PAGE_SIZE: 100,
  RESOURCE_DEFAULT_MAX_PAGES: 5,
  RESOURCE_MAX_PAGES: 20,
  RESOURCE_CACHE_MAX_SECONDS: 300,
  EMPLOYEE_HISTORY_LOOKBACK_DAYS: 120,
  ADMIN_TABLE_PAGE_SIZE: 25,
  ADMIN_AUDIT_QUERY_LIMIT: 250,
  ADMIN_BULK_REVIEW_LIMIT: 100,
  KIOSK_ONLINE_WINDOW_MS: 90_000,
  QR_VALIDITY_MIN_SECONDS: 15,
  QR_VALIDITY_MAX_SECONDS: 300,
  QR_REFRESH_MIN_SECONDS: 10,
  QR_REFRESH_MAX_SECONDS: 240,
  QR_REFRESH_SAFETY_SECONDS: 5,
  ACCOUNT_PASSWORD_MIN_LENGTH: 8,
  TEMP_PASSWORD_LENGTH: 16,
  MAX_ANNUAL_LEAVE_DAYS: 365,
  KIOSK_QR_SIZE_PX: 320,
} as const;

export const TMS_STORAGE = {
  AVATAR_BUCKET: 'avatars',
  AVATAR_FILE_NAME: 'avatar.jpg',
  AVATAR_CACHE_SECONDS: 3_600,
  AVATAR_MIME_TYPES: ['image/jpeg', 'image/png', 'image/webp'] as const,
} as const;

export const LEAVE_REQUEST_TYPES = [
  'Nghỉ phép',
  'Nghỉ ốm',
  'Nghỉ không lương',
  'Công tác',
  'Làm việc tại nhà',
] as const;

export const TMS_DEFAULT_POLICY = {
  WORK_DAYS: [1, 2, 3, 4, 5],
  EXPECTED_START: '08:30',
  EXPECTED_END: '17:30',
  LATE_TOLERANCE_MINUTES: 5,
  EARLY_TOLERANCE_MINUTES: 5,
  CHECKIN_WINDOW_START: '07:30',
  CHECKIN_WINDOW_END: '10:00',
  CHECKOUT_WINDOW_START: '16:00',
  CHECKOUT_WINDOW_END: '20:00',
  UNPAID_BREAK_MINUTES: 90,
} as const;

export const TMS_DEFAULT_SYSTEM_CONFIG: SystemConfig = {
  LATE_TOLERANCE: 15,
  MIN_HOURS_FULL: 7,
  MIN_HOURS_HALF: 3.5,
  LUNCH_START: '12:00',
  LUNCH_END: '13:30',
  OFF_DAYS: [0],
  MAX_DISTANCE_METERS: TMS_LIMITS.DEFAULT_GEOFENCE_METERS,
  LOCK_DATE: 5,
  MAX_EXPLANATIONS_PER_MONTH: 5,
  QR_REFRESH_SECONDS: TMS_LIMITS.QR_REFRESH_MS / 1_000,
  QR_VALIDITY_SECONDS: TMS_LIMITS.QR_VALIDITY_SECONDS,
};

export const TMS_DEFAULT_SHIFTS = [
  { name: 'Ca Sáng', start: '08:30', end: '12:00', break_point: '13:00' },
  { name: 'Ca Chiều', start: '14:00', end: '17:30', break_point: '17:30' },
  { name: 'Ca Tối', start: '17:30', end: '21:00', break_point: '23:59' },
] as const satisfies readonly ShiftConfig[];

export const TMS_DEFAULTS = {
  ANNUAL_LEAVE_DAYS: 12,
} as const;

export const LOGIN_EMAIL_DOMAINS: readonly string[] = [...new Set<string>(
  String(ENV_LOGIN_DOMAINS).split(',').map((domain) => domain.trim().toLowerCase()).filter(Boolean),
)];
