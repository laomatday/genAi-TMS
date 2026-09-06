import { supabase, isSupabaseConfigured } from '@/core/supabase';
import { getCurrentDeviceId } from '@/core/deviceBinding';
import { TMS_LIMITS } from '@/shared/constants';
import type {
  AttendanceBootstrap,
  DynamicQrResult,
  Employee,
  WorkforceAttendanceResult,
  WorkforceReceipt,
} from '@/shared/types';

function rpcError(error: { message: string } | null, data: unknown, operation: string) {
  if (error) throw new Error(error.message);
  if (!data || typeof data !== 'object') throw new Error(`${operation} không trả về dữ liệu hợp lệ.`);
  const payload = data as WorkforceAttendanceResult;
  if (payload.ok === false) throw new Error(payload.message || `${operation} thất bại.`);
}

function commandId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function getAttendanceBootstrap(): Promise<AttendanceBootstrap> {
  if (!isSupabaseConfigured) {
    throw new Error('Chưa cấu hình Supabase. Vui lòng kiểm tra biến môi trường.');
  }
  const { data, error } = await supabase.rpc('workforce_query', {
    p_resource: 'bootstrap',
    p_args: {},
  });
  if (error) throw new Error(error.message);
  if (!data || typeof data !== 'object') throw new Error('Không tải được trạng thái chấm công.');
  const payload = data as Record<string, unknown>;
  const profile = payload.profile as Employee | undefined;
  if (!profile?.employee_id) throw new Error('Không tìm thấy hồ sơ nhân viên.');
  return {
    profile: { ...profile, id: profile.employee_id, uid: profile.auth_user_id },
    history: [],
    serverTime: typeof payload.server_time === 'string' ? payload.server_time : new Date().toISOString(),
  };
}

export async function recordQrAttendance(input: {
  qrPayload: string;
  lat: number;
  lng: number;
  accuracy: number;
}): Promise<{ receipt: WorkforceReceipt; message: string }> {
  if (!isSupabaseConfigured) throw new Error('Chưa cấu hình Supabase.');

  const { data, error } = await supabase.rpc('workforce_command', {
    p_action: 'attendance',
    p_args: {
      action: 'checkin',
      command_id: commandId(),
      device_id: getCurrentDeviceId(),
      qr_payload: input.qrPayload,
      lat: input.lat,
      lng: input.lng,
      accuracy: input.accuracy,
    },
  });
  rpcError(error, data, 'Chấm công QR');
  const result = data as WorkforceAttendanceResult;
  if (!result.receipt) throw new Error('Hệ thống chưa trả về biên nhận chấm công.');
  return { receipt: result.receipt, message: result.message || 'Hệ thống đã ghi nhận Check-in.' };
}

export async function runAttendanceAction(
  action: 'checkout' | 'pause' | 'resume',
  input: { lat: number; lng: number; accuracy: number },
): Promise<{ receipt: WorkforceReceipt; message: string }> {
  if (!isSupabaseConfigured) throw new Error('Chưa cấu hình Supabase.');
  const { data, error } = await supabase.rpc('workforce_command', {
    p_action: 'attendance',
    p_args: {
      action,
      command_id: commandId(),
      device_id: getCurrentDeviceId(),
      lat: input.lat,
      lng: input.lng,
      accuracy: input.accuracy,
    },
  });
  rpcError(error, data, action === 'checkout' ? 'Check-out' : 'Cập nhật trạng thái ca');
  const result = data as WorkforceAttendanceResult;
  if (!result.receipt) throw new Error('Hệ thống chưa trả về biên nhận thao tác.');
  return { receipt: result.receipt, message: result.message || 'Hệ thống đã ghi nhận.' };
}

export async function createAttendanceQr(centerId?: string) {
  if (!isSupabaseConfigured) throw new Error('Chưa cấu hình Supabase.');
  const { data, error } = await supabase.rpc('create_attendance_qr', {
    p_center_id: centerId || null,
  });
  if (error) throw new Error(error.message);
  if (!data || typeof data !== 'object') throw new Error('Tạo mã QR không trả về dữ liệu hợp lệ.');
  return data as DynamicQrResult;
}

export async function getQrTimingConfig() {
  const fallback = {
    refreshMs: TMS_LIMITS.QR_REFRESH_MS,
    validitySeconds: TMS_LIMITS.QR_VALIDITY_SECONDS,
  };
  if (!isSupabaseConfigured) return fallback;

  const { data, error } = await supabase
    .from('config_system')
    .select('key,value')
    .in('key', ['QR_REFRESH_SECONDS', 'QR_VALIDITY_SECONDS']);
  if (error) return fallback;

  const values = new Map((data || []).map((row) => [row.key, Number(row.value)]));
  const refreshSeconds = values.get('QR_REFRESH_SECONDS');
  const validitySeconds = values.get('QR_VALIDITY_SECONDS');
  const validRefreshSeconds = Number.isFinite(refreshSeconds)
    ? Math.min(TMS_LIMITS.QR_REFRESH_MAX_SECONDS, Math.max(TMS_LIMITS.QR_REFRESH_MIN_SECONDS, refreshSeconds!))
    : fallback.refreshMs / TMS_LIMITS.CLOCK_REFRESH_MS;
  const validValiditySeconds = Number.isFinite(validitySeconds)
    ? Math.min(TMS_LIMITS.QR_VALIDITY_MAX_SECONDS, Math.max(TMS_LIMITS.QR_VALIDITY_MIN_SECONDS, validitySeconds!))
    : fallback.validitySeconds;
  const safeRefreshSeconds = Math.min(
    validRefreshSeconds,
    Math.max(TMS_LIMITS.QR_REFRESH_MIN_SECONDS, validValiditySeconds - TMS_LIMITS.QR_REFRESH_SAFETY_SECONDS),
  );
  return {
    refreshMs: safeRefreshSeconds * TMS_LIMITS.CLOCK_REFRESH_MS,
    validitySeconds: validValiditySeconds,
  };
}
