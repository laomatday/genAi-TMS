import type { EmployeeRole, ShiftConfig, SystemConfig } from '@/shared/types';

const ENV_DOMAIN = typeof import.meta !== 'undefined' && import.meta.env?.VITE_APP_DOMAIN ? import.meta.env.VITE_APP_DOMAIN : 'genai.ai.vn';
const ENV_BRAND = typeof import.meta !== 'undefined' && import.meta.env?.VITE_APP_BRAND ? import.meta.env.VITE_APP_BRAND : 'genAi';
const ENV_PHONE = typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPPORT_PHONE ? import.meta.env.VITE_SUPPORT_PHONE : '19001234';
const ENV_PHONE_LABEL = typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPPORT_PHONE_LABEL ? import.meta.env.VITE_SUPPORT_PHONE_LABEL : '1900 1234 (Nhánh 1)';

export const APP_INFO = {
  NAME: ENV_BRAND,
  BRAND: ENV_BRAND,
  PRODUCT_NAME: `${ENV_BRAND} TMS`,
  VERSION: '2.1.0',
  DOMAIN: ENV_DOMAIN,
  WEBSITE_URL: `https://${ENV_DOMAIN}`,
  CONTACT_EMAIL: `support@${ENV_DOMAIN}`,
  LOGO_URL: '/genai-symbol.svg',
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
export const SCOPED_MANAGEMENT_ROLES: readonly EmployeeRole[] = ['Leader', 'Manager', 'Director'];
export const ADMIN_ROUTE_ROLES: readonly EmployeeRole[] = ['Admin', 'HR', 'Director'];
export const DEVICE_EXEMPT_ROLES: readonly EmployeeRole[] = ['Admin', 'Kiosk'];

export const STORAGE_KEYS = {
  THEME: 'genai_theme',
  HISTORY_VIEW: 'genai_history_view_mode',
  CONTACTS_CACHE: 'genai_contacts_cache',
  SEEN_NOTIFICATIONS: 'genai_seen_noti_count',
  GUIDE_SEEN: 'genai_guide_seen_v2026',
  DEVICE_ID: 'genai_tms_device_id_v2',
  DB_NAME: 'genai-tms-device',
  STORE_NAME: 'keys',
} as const;

export const VI_DAYS_OF_WEEK = [
  'CHỦ NHẬT',
  'THỨ HAI',
  'THỨ BA',
  'THỨ TƯ',
  'THỨ NĂM',
  'THỨ SÁU',
  'THỨ BẢY',
] as const;

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
  PAGE_OFFSET_PX: 20,
  PAGE_TRANSITION: {
    duration: 0.2,
    ease: 'easeInOut',
  },
} as const;

export const TMS_LIMITS = {
  DEFAULT_GEOFENCE_METERS: 200 as number,
  GOOD_GPS_ACCURACY_METERS: 50,
  MAX_GPS_ACCURACY_METERS: 150,
  GPS_TIMEOUT_MS: 12_000,
  DASHBOARD_REFRESH_MS: 120_000,
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
  SWIPE_NAVIGATION_PX: 50,
  SWIPE_MODAL_CLOSE_PX: 60,
  CONTACT_SEARCH_DEBOUNCE_MS: 300,
  INPUT_FOCUS_DELAY_MS: 150,
  MAX_AVATAR_FILE_BYTES: 10 * 1024 * 1024,
  MAX_AVATAR_STORAGE_BYTES: 2 * 1024 * 1024,
  AVATAR_OUTPUT_PIXELS: 500,
  AVATAR_JPEG_QUALITY: 0.88,
  MAX_SPREADSHEET_FILE_BYTES: 5 * 1024 * 1024,
  MAX_SPREADSHEET_IMPORT_ROWS: 1_000,
  ADMIN_FETCH_BATCH_SIZE: 1_000,
  ADMIN_TABLE_PAGE_SIZE: 25,
  ADMIN_AUDIT_QUERY_LIMIT: 250,
  ADMIN_BULK_REVIEW_LIMIT: 100,
  KIOSK_ONLINE_WINDOW_MS: 90_000,
  QR_VALIDITY_MIN_SECONDS: 15,
  QR_VALIDITY_MAX_SECONDS: 300,
  QR_REFRESH_MIN_SECONDS: 10,
  QR_REFRESH_MAX_SECONDS: 240,
  QR_REFRESH_SAFETY_SECONDS: 5,
  ACCOUNT_PASSWORD_MIN_LENGTH: 12,
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

export const LOGIN_EMAIL_DOMAINS: readonly string[] = [ENV_DOMAIN];
