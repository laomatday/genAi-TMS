import { supabase, isSupabaseConfigured } from '@/core/supabase';
import { LOGIN_EMAIL_DOMAINS, TMS_DEFAULTS, TMS_LIMITS } from '@/shared/constants';
import {
  AUTH_LOGIN_UNAVAILABLE_MESSAGE,
  isRetryableAuthFailure,
  withAuthDeadline,
} from './authFailure';
import { rememberEffectiveCapabilities } from '@/modules/tms/services/workforceCapabilities';
import type { Employee } from '@/shared/types';
import { clearWorkforceResourceCache, primeWorkforceCache } from '@/modules/tms/services/workforceApi';

export async function fetchMyProfile(expectedAuthUserId?: string): Promise<Employee> {
  if (!isSupabaseConfigured) {
    throw new Error('Chưa cấu hình kết nối Supabase. Vui lòng kiểm tra biến môi trường.');
  }

  let authUserId = expectedAuthUserId?.trim() || '';
  if (!authUserId) {
    const { data: authData, error: authError } = await supabase.auth.getUser();
    if (authError) throw authError;
    if (!authData.user) throw new Error('Vui lòng đăng nhập.');
    authUserId = authData.user.id;
  }

  const { data: response, error } = await supabase.rpc('workforce_query', {
    p_resource: 'bootstrap',
    p_args: {},
  });
  const data = response && typeof response === 'object' && !Array.isArray(response)
    ? (response as Record<string, unknown>).profile as Record<string, unknown> | undefined
    : undefined;
  if (error) throw error;
  if (!data || data.auth_user_id !== authUserId) {
    throw new Error('Không tìm thấy hồ sơ nhân viên.');
  }

  const subject = `${String(data.organization_id ?? '')}:${String(data.employee_id ?? '')}`;
  // The same response already carries the effective capabilities. Pass them on so
  // the Control Center does not re-request the identical RPC moments later.
  rememberEffectiveCapabilities(subject, response);
  // And file the response itself, so the dashboard that loads next reads it from
  // the cache instead of asking for the identical resource again.
  // bootstrap carries no ttl of its own, so the window is stated here — the
  // same one the dashboard asks for, which is what makes the entry a hit.
  primeWorkforceCache('bootstrap', response as Record<string, unknown>, {
    scope: subject,
    ttlSeconds: Math.ceil(TMS_LIMITS.DASHBOARD_VISIBLE_STALE_MS / 1_000),
  });

  const annualLeaveBalance = Number(data.annual_leave_balance ?? TMS_DEFAULTS.ANNUAL_LEAVE_DAYS);

  return {
    ...data,
    annual_leave_balance: Number.isFinite(annualLeaveBalance) ? annualLeaveBalance : TMS_DEFAULTS.ANNUAL_LEAVE_DAYS,
    id: String(data.employee_id),
    uid: String(data.auth_user_id),
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

async function bestEffortLocalSignOut() {
  // Reference data is written through to IndexedDB to spare the database a
  // round trip on every restart. It is this employee's data, so it leaves with
  // them — phones get handed over, and stations are shared by definition.
  clearWorkforceResourceCache();
  try {
    await withAuthDeadline(supabase.auth.signOut({ scope: 'local' }));
  } catch (error) {
    console.warn('Unable to complete remote sign-out:', error);
  }
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
      const { data: authData, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      let profile: Employee;
      try {
        profile = await withAuthDeadline(fetchMyProfile(authData.user?.id));
      } catch (error) {
        if (isRetryableAuthFailure(error)) {
          console.warn('Authentication service temporarily unavailable:', error);
          return {
            success: false as const,
            sessionEstablished: true as const,
            message: AUTH_LOGIN_UNAVAILABLE_MESSAGE,
          };
        }
        console.error('Unable to load authenticated profile:', error);
        await bestEffortLocalSignOut();
        return {
          success: false as const,
          message: error instanceof Error ? error.message : 'Không thể tải hồ sơ nhân viên.',
        };
      }
      if (profile.status !== 'Active') {
        await bestEffortLocalSignOut();
        return { success: false as const, message: 'Tài khoản đã bị vô hiệu hóa.' };
      }
      if (!profile.organization_id) {
        await bestEffortLocalSignOut();
        return { success: false as const, message: 'Hồ sơ chưa được gán tổ chức. Vui lòng liên hệ quản trị hệ thống.' };
      }

      return { success: true as const, data: profile };
    } catch (error) {
      lastError = error;
      if (isRetryableAuthFailure(error)) {
        console.warn('Authentication service temporarily unavailable:', error);
        return { success: false as const, message: AUTH_LOGIN_UNAVAILABLE_MESSAGE };
      }
    }
  }

  console.error('Login failed:', lastError);
  await bestEffortLocalSignOut();
  return { success: false as const, message: 'Tài khoản hoặc mật khẩu không đúng.' };
}
