import { EMPLOYEE_ROLES, TMS_LIMITS } from '@/shared/constants';
import type { EmployeeInput } from './adminService';
import type { AdminData } from './types';

/**
 * The account editor is split into sections because the form carries more than
 * thirty controls — identity, posting, access and a per-employee permission
 * matrix — and asking someone to scroll one flat column through all of it is
 * what made the screen hard to work with.
 *
 * Validation reports which section a problem belongs to, so a complaint about
 * the attendance policy opens the section that holds it instead of appearing as
 * a message above a field that is out of view.
 */
export type AccountEditorSection = 'profile' | 'work' | 'access' | 'capabilities';

export const ACCOUNT_EDITOR_SECTIONS: ReadonlyArray<{
  id: AccountEditorSection;
  label: string;
  hint: string;
  icon: string;
}> = [
  { id: 'profile', label: 'Hồ sơ', hint: 'Danh tính và liên hệ', icon: 'badge' },
  { id: 'work', label: 'Công việc', hint: 'Vai trò, nơi làm và chấm công', icon: 'work' },
  { id: 'access', label: 'Truy cập', hint: 'Mật khẩu, thiết bị, trạng thái', icon: 'lock' },
  { id: 'capabilities', label: 'Quyền riêng', hint: 'Khác với vai trò', icon: 'shield_person' },
];

export interface AccountValidationError {
  section: AccountEditorSection;
  message: string;
}

export function validateAccount(
  employee: EmployeeInput,
  mode: 'create' | 'update',
  hasAuthAccount: boolean,
  data: AdminData,
): AccountValidationError | null {
  const fail = (section: AccountEditorSection, message: string): AccountValidationError => ({ section, message });

  if (!/^[A-Z0-9_-]{2,40}$/.test(employee.employee_id.trim().toUpperCase())) {
    return fail('profile', 'Mã nhân viên cần từ 2–40 ký tự, chỉ gồm chữ, số, gạch ngang hoặc gạch dưới.');
  }
  if (!employee.name.trim()) return fail('profile', 'Vui lòng nhập họ tên nhân viên.');
  if (!/^\S+@\S+\.\S+$/.test(employee.email.trim())) return fail('profile', 'Email đăng nhập không đúng định dạng.');
  if (!EMPLOYEE_ROLES.includes(employee.role)) return fail('work', 'Vai trò nhân viên không hợp lệ.');
  if (!data.locations.some((location) => location.center_id === employee.center_id)) {
    return fail('work', 'Vui lòng chọn địa điểm chính hợp lệ.');
  }
  if (employee.role !== 'Kiosk' && !data.policies.some((policy) => policy.id === employee.attendance_policy_id && policy.active)) {
    return fail('work', 'Vui lòng chọn chính sách chấm công đang hoạt động.');
  }
  const locationIds = new Set(data.locations.map((location) => location.center_id));
  if ([...(employee.allowed_locations || []), ...(employee.managed_locations || [])].some((id) => !locationIds.has(id))) {
    return fail('work', 'Danh sách địa điểm được gán có mục không còn tồn tại.');
  }
  if (employee.direct_manager_id === employee.employee_id) {
    return fail('work', 'Nhân viên không thể là quản lý trực tiếp của chính mình.');
  }
  const annualLeave = Number(employee.annual_leave_balance);
  if (!Number.isFinite(annualLeave) || annualLeave < 0 || annualLeave > TMS_LIMITS.MAX_ANNUAL_LEAVE_DAYS) {
    return fail('work', 'Số ngày phép còn lại không hợp lệ.');
  }
  const passwordRequired = mode === 'create' || (!hasAuthAccount && employee.status === 'Active');
  if (passwordRequired && (employee.password || '').length < TMS_LIMITS.ACCOUNT_PASSWORD_MIN_LENGTH) {
    return fail('access', `Mật khẩu tạm phải có ít nhất ${TMS_LIMITS.ACCOUNT_PASSWORD_MIN_LENGTH} ký tự.`);
  }
  if (employee.password && employee.password.length < TMS_LIMITS.ACCOUNT_PASSWORD_MIN_LENGTH) {
    return fail('access', `Mật khẩu mới phải có ít nhất ${TMS_LIMITS.ACCOUNT_PASSWORD_MIN_LENGTH} ký tự.`);
  }
  return null;
}

/** Sections a Kiosk account has no use for — it has no person behind it. */
export function sectionsForRole(role: EmployeeInput['role']): ReadonlyArray<typeof ACCOUNT_EDITOR_SECTIONS[number]> {
  if (role !== 'Kiosk') return ACCOUNT_EDITOR_SECTIONS;
  return ACCOUNT_EDITOR_SECTIONS.filter((section) => section.id !== 'capabilities');
}
