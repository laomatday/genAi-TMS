import { supabase, isSupabaseConfigured } from '@/core/supabase';
import { LOGIN_EMAIL_DOMAINS, STORAGE_KEYS, TMS_DEFAULTS } from '@/shared/constants';
import type { Employee } from '@/shared/types';

export const isDemoModeAllowed = !isSupabaseConfigured || (typeof import.meta !== 'undefined' && import.meta.env?.VITE_ENABLE_DEMO_MODE === 'true');

export const DEMO_ADMIN: Employee = {
  id: 'EMP_ADMIN_01',
  employee_id: 'ADMIN01',
  uid: 'demo-admin-uid',
  auth_user_id: 'demo-admin-uid',
  name: 'Nguyễn Quản Trị (Admin)',
  email: 'admin@genai.ai.vn',
  phone: '0901234567',
  role: 'Admin',
  center_id: 'HQ',
  allowed_locations: ['HQ', 'BRANCH1', 'BRANCH2'],
  managed_locations: ['HQ', 'BRANCH1', 'BRANCH2'],
  annual_leave_balance: 12,
  position: 'Giám đốc Vận hành / Quản trị viên',
  department: 'Ban Giám Đốc',
  status: 'Active',
};

export const DEMO_STAFF: Employee = {
  id: 'EMP_STAFF_01',
  employee_id: 'NV001',
  uid: 'demo-staff-uid',
  auth_user_id: 'demo-staff-uid',
  name: 'Trần Thị Thu Trang',
  email: 'trang.tran@genai.ai.vn',
  phone: '0987654321',
  role: 'Staff',
  center_id: 'HQ',
  allowed_locations: ['HQ'],
  annual_leave_balance: 10,
  position: 'Chuyên viên Nhân sự',
  department: 'Khối Vận hành',
  status: 'Active',
};

export const DEMO_KIOSK: Employee = {
  id: 'EMP_KIOSK_01',
  employee_id: 'KIOSK01',
  uid: 'demo-kiosk-uid',
  auth_user_id: 'demo-kiosk-uid',
  name: 'Kiosk Điểm danh Trụ sở',
  email: 'kiosk@genai.ai.vn',
  role: 'Kiosk',
  center_id: 'HQ',
  status: 'Active',
};

export async function fetchMyProfile(): Promise<Employee> {
  if (!isSupabaseConfigured) {
    const saved = localStorage.getItem(STORAGE_KEYS.DEMO_USER);
    if (saved) {
      try {
        return JSON.parse(saved) as Employee;
      } catch {
        // ignore
      }
    }
    throw new Error('Vui lòng đăng nhập.');
  }

  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) throw new Error('Vui lòng đăng nhập.');

  const { data, error } = await supabase
    .from('employees')
    .select('employee_id, auth_user_id, name, email, phone, role, center_id, allowed_locations, managed_locations, direct_manager_id, annual_leave_balance, attendance_policy_id, trusted_device_id, trusted_device_bound_at, position, department, avatar_url, face_ref_url, status')
    .eq('auth_user_id', authData.user.id)
    .single();

  if (error || !data) throw new Error('Không tìm thấy hồ sơ nhân viên.');

  const annualLeaveBalance = Number(data.annual_leave_balance ?? TMS_DEFAULTS.ANNUAL_LEAVE_DAYS);

  return {
    ...data,
    annual_leave_balance: Number.isFinite(annualLeaveBalance) ? annualLeaveBalance : TMS_DEFAULTS.ANNUAL_LEAVE_DAYS,
    id: data.employee_id,
    uid: data.auth_user_id,
  } as Employee;
}

export async function doLogin(loginId: string, password: string) {
  const cleanId = loginId.trim().toLowerCase();

  // Demo account flow for sandbox or when Supabase is not configured
  if (isDemoModeAllowed) {
    if (!isSupabaseConfigured || cleanId === 'admin' || cleanId === 'admin@genai.ai.vn' || cleanId === 'demo') {
      const user = cleanId.includes('kiosk') ? DEMO_KIOSK : cleanId.includes('staff') || cleanId.includes('nv') ? DEMO_STAFF : DEMO_ADMIN;
      localStorage.setItem(STORAGE_KEYS.DEMO_USER, JSON.stringify(user));
      return { success: true as const, data: user };
    }

    if (cleanId === 'nhanvien' || cleanId === 'staff' || cleanId === 'nv001') {
      localStorage.setItem(STORAGE_KEYS.DEMO_USER, JSON.stringify(DEMO_STAFF));
      return { success: true as const, data: DEMO_STAFF };
    }

    if (cleanId === 'kiosk') {
      localStorage.setItem(STORAGE_KEYS.DEMO_USER, JSON.stringify(DEMO_KIOSK));
      return { success: true as const, data: DEMO_KIOSK };
    }
  }

  const candidates = cleanId.includes('@')
    ? [cleanId]
    : LOGIN_EMAIL_DOMAINS.map((domain) => `${cleanId}@${domain}`);

  let lastError: unknown;
  for (const email of candidates) {
    try {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      const profile = await fetchMyProfile();
      if (profile.status !== 'Active') {
        await supabase.auth.signOut({ scope: 'local' });
        return { success: false as const, message: 'Tài khoản đã bị vô hiệu hóa.' };
      }

      // Trusted Device activation/verification is intentionally handled by DeviceGate
      // after account authentication so first activation is explicit to the employee.
      return { success: true as const, data: profile };
    } catch (error) {
      lastError = error;
      await supabase.auth.signOut({ scope: 'local' });
    }
  }

  console.error('Login failed:', lastError);
  return { success: false as const, message: 'Tài khoản hoặc mật khẩu không đúng.' };
}

