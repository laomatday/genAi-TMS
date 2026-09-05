import { supabase, isSupabaseConfigured } from '@/core/supabase';
import { STORAGE_KEYS, TMS_LIMITS } from '@/shared/constants';
import type {
  Attendance,
  AttendanceBootstrap,
  DynamicQrResult,
  RecordAttendanceResult,
} from '@/shared/types';

function rpcError(error: { message: string } | null, data: unknown, operation: string) {
  if (error) throw new Error(error.message);
  if (!data || typeof data !== 'object') throw new Error(`${operation} không trả về dữ liệu hợp lệ.`);
}

function getDemoBootstrap(): AttendanceBootstrap {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = today.getDate();

  const history: Attendance[] = [];
  for (let d = 1; d <= day; d++) {
    const dStr = String(d).padStart(2, '0');
    const dateStr = `${year}-${month}-${dStr}`;
    const dayOfWeek = new Date(year, today.getMonth(), d).getDay();
    if (dayOfWeek === 0) continue;

    const isToday = d === day;
    history.push({
      id: `att-${dateStr}`,
      date: dateStr,
      employee_id: 'NV001',
      name: 'Trần Thị Thu Trang',
      center_id: 'HQ',
      location_name: 'Trụ sở chính',
      shift_name: 'Ca Chuẩn',
      shift_start: '08:30',
      shift_end: '17:30',
      time_in: '08:25',
      time_out: isToday ? '' : '17:35',
      checkin_type: 'QR_GPS',
      checkin_lat: 21.028511,
      checkin_lng: 105.854444,
      distance_meters: 18,
      location_accuracy_m: 12,
      late_minutes: 0,
      early_minutes: 0,
      work_hours: isToday ? 5.0 : 8.0,
      status: 'Valid',
      is_valid: 'Yes',
      note: 'Điểm danh đúng giờ',
      timestamp: Date.now(),
    });
  }

  const savedUser = localStorage.getItem(STORAGE_KEYS.DEMO_USER);
  let profile = {
    id: 'EMP_STAFF_01',
    employee_id: 'NV001',
    name: 'Trần Thị Thu Trang',
    email: 'trang.tran@genai.ai.vn',
    role: 'Staff' as const,
    center_id: 'HQ',
    status: 'Active' as const,
    annual_leave_balance: 10,
    department: 'Khối Vận hành',
    position: 'Chuyên viên',
  };
  if (savedUser) {
    try {
      profile = { ...profile, ...JSON.parse(savedUser) };
    } catch {}
  }

  return {
    profile: profile as any,
    history,
    serverTime: new Date().toISOString(),
  };
}

export async function getAttendanceBootstrap(): Promise<AttendanceBootstrap> {
  if (!isSupabaseConfigured) {
    return getDemoBootstrap();
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
    const now = new Date();
    const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    return {
      action: 'checkin',
      message: 'Chấm công Demo thành công!',
      attendance: {
        id: `att-demo-${Date.now()}`,
        date: todayStr,
        employee_id: 'NV001',
        name: 'Trần Thị Thu Trang',
        center_id: 'HQ',
        location_name: 'Trụ sở chính',
        time_in: timeStr,
        time_out: '',
        checkin_type: 'QR_GPS',
        checkin_lat: input.lat,
        checkin_lng: input.lng,
        distance_meters: 10,
        late_minutes: 0,
        early_minutes: 0,
        work_hours: 0,
        status: 'Valid',
        is_valid: 'Yes',
        note: 'Chấm công Demo',
        timestamp: Date.now(),
      },
    } as RecordAttendanceResult;
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
    return {
      payload: `DEMO_QR_${centerId || 'HQ'}_${Date.now()}`,
      expiresAt: Date.now() + 45_000,
      branchName: 'Trụ sở chính (genAi HQ)',
    } as DynamicQrResult;
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
