import { supabase, isSupabaseConfigured } from '@/core/supabase';
import { TMS_LIMITS } from '@/shared/constants';
import type {
  AttendanceBootstrap,
  DynamicQrResult,
  RecordAttendanceResult,
} from '@/shared/types';

function rpcError(error: { message: string } | null, data: unknown, operation: string) {
  if (error) throw new Error(error.message);
  if (!data || typeof data !== 'object') throw new Error(`${operation} không trả về dữ liệu hợp lệ.`);
}

export async function getAttendanceBootstrap(): Promise<AttendanceBootstrap> {
  if (!isSupabaseConfigured) {
    throw new Error('Chưa cấu hình Supabase. Vui lòng kiểm tra biến môi trường.');
  }
  const { data, error } = await supabase.rpc('get_my_attendance');
  rpcError(error, data, 'Tải dữ liệu chấm công');
  return data as AttendanceBootstrap;
}

export async function recordQrAttendance(input: {
  qrPayload: string;
  lat: number;
  lng: number;
  accuracy: number;
}) {
  if (!isSupabaseConfigured) {
    throw new Error('Chưa cấu hình Supabase.');
  }
  const { data, error } = await supabase.rpc('record_qr_attendance', {
    p_qr_payload: input.qrPayload,
    p_lat: input.lat,
    p_lng: input.lng,
    p_accuracy: input.accuracy,
  });
  rpcError(error, data, 'Chấm công QR');
  return data as RecordAttendanceResult;
}

export async function createAttendanceQr(centerId?: string) {
  if (!isSupabaseConfigured) {
    throw new Error('Chưa cấu hình Supabase.');
  }
  const { data, error } = await supabase.rpc('create_attendance_qr', {
    p_center_id: centerId || null,
  });
  rpcError(error, data, 'Tạo mã QR');
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
