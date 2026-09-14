import { supabase, isSupabaseConfigured } from '@/core/supabase';
import { LOGIN_EMAIL_DOMAINS, TMS_DEFAULTS } from '@/shared/constants';
import type { Employee } from '@/shared/types';

export async function fetchMyProfile(): Promise<Employee> {
  if (!isSupabaseConfigured) {
    throw new Error('Chưa cấu hình kết nối Supabase. Vui lòng kiểm tra biến môi trường.');
  }

  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) throw new Error('Vui lòng đăng nhập.');

  const { data, error } = await supabase
    .from('employees')
    .select('employee_id, auth_user_id, organization_id, name, email, phone, role, center_id, allowed_locations, managed_locations, direct_manager_id, annual_leave_balance, attendance_policy_id, trusted_device_id, trusted_device_bound_at, position, department, avatar_url, face_ref_url, employment_start_date, employment_end_date, status')
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

// Exported for direct unit testing (see authService.test.ts) — a login id without "@"
// is tried against every configured company domain in turn.
export function buildLoginEmailCandidates(loginId: string): string[] {
  const cleanId = loginId.trim().toLowerCase();
  return cleanId.includes('@')
    ? [cleanId]
    : LOGIN_EMAIL_DOMAINS.map((domain) => `${cleanId}@${domain}`);
}

export async function doLogin(loginId: string, password: string) {
  if (!isSupabaseConfigured) {
    return {
      success: false as const,
      message: 'Hệ thống chưa kết nối cơ sở dữ liệu. Vui lòng cấu hình VITE_SUPABASE_URL và VITE_SUPABASE_PUBLISHABLE_KEY trên Vercel.',
    };
  }

  const candidates = buildLoginEmailCandidates(loginId);

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
      if (!profile.organization_id) {
        await supabase.auth.signOut({ scope: 'local' });
        return { success: false as const, message: 'Hồ sơ chưa được gán tổ chức. Vui lòng liên hệ quản trị hệ thống.' };
      }

      return { success: true as const, data: profile };
    } catch (error) {
      lastError = error;
      await supabase.auth.signOut({ scope: 'local' });
    }
  }

  console.error('Login failed:', lastError);
  return { success: false as const, message: 'Tài khoản hoặc mật khẩu không đúng.' };
}
