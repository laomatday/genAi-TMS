import { supabase, isSupabaseConfigured } from '@/core/supabase';
import { getCurrentDeviceId } from '@/core/deviceBinding';
import { timeToMinutes } from '@/core/utils/helpers';
import { TMS_DEFAULT_SHIFTS, TMS_LIMITS, TMS_STORAGE } from '@/shared/constants';
import type { DashboardData, ReviewStatus, ShiftConfig } from '@/shared/types';

type DataRow = Record<string, unknown>;
type DecisionStatus = Exclude<ReviewStatus, 'Pending'>;

function optionalText(value: unknown) {
  const text = typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
  return text || undefined;
}

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    return error.message;
  }
  return fallback;
}

function ok(message: string) {
  return { success: true as const, message };
}

function err(error: unknown, fallback = 'Không thể hoàn tất thao tác.') {
  return { success: false as const, message: errorMessage(error, fallback) };
}

function rpcText(data: unknown, field: string) {
  if (!data || typeof data !== 'object' || !(field in data)) return undefined;
  return optionalText((data as DataRow)[field]);
}

function assertRpcSuccess(data: unknown, fallback: string) {
  if (!data || typeof data !== 'object') throw new Error(fallback);
  if ('success' in data && (data as { success?: unknown }).success === false) {
    throw new Error(rpcText(data, 'message') || fallback);
  }
}

export function determineShift(timeStr: string, shifts: ShiftConfig[]): ShiftConfig {
  const fallback: ShiftConfig = { ...TMS_DEFAULT_SHIFTS[0] };
  if (!shifts.length) return fallback;

  const sorted = [...shifts].sort((a, b) => timeToMinutes(a.start) - timeToMinutes(b.start));
  const current = timeToMinutes(timeStr);
  const firstShift = sorted[0] ?? fallback;
  if (current < timeToMinutes(firstShift.start)) return firstShift;

  for (const shift of sorted) {
    let boundary = timeToMinutes(shift.break_point || shift.end);
    const start = timeToMinutes(shift.start);
    if (boundary < start) boundary += 1440;
    if (current <= boundary) return shift;
  }
  return sorted[sorted.length - 1] ?? firstShift;
}

export async function getDashboardData(_employeeId: string): Promise<{ success: boolean; data?: DashboardData; message?: string }> {
  try {
    if (!isSupabaseConfigured) {
      throw new Error('Chưa cấu hình Supabase. Vui lòng kiểm tra biến môi trường.');
    }
    const { data, error } = await supabase.rpc('get_my_dashboard_v3');
    if (error) throw error;
    if (!data || typeof data !== 'object') throw new Error('Dashboard không trả về dữ liệu hợp lệ.');
    return { success: true, data: data as DashboardData };
  } catch (error) {
    return { success: false, message: errorMessage(error, 'Không tải được dữ liệu.') };
  }
}

interface SubmitRequestInput {
  type: string;
  fromDate: string;
  toDate: string;
  reason: string;
}

export async function submitRequest(input: SubmitRequestInput) {
  try {
    const { error } = await supabase.rpc('submit_leave_request', {
      p_type: input.type,
      p_from_date: input.fromDate,
      p_to_date: input.toDate,
      p_reason: input.reason,
    });
    if (error) throw error;
    return ok('Gửi đề xuất thành công!');
  } catch (error) {
    return err(error);
  }
}

export async function submitExplanation(input: { date: string; reason: string }) {
  try {
    const { error } = await supabase.rpc('submit_attendance_explanation_v3', {
      p_attendance_date: input.date,
      p_reason: input.reason,
    });
    if (error) throw error;
    return ok('Gửi giải trình thành công!');
  } catch (error) {
    return err(error);
  }
}

export async function deleteRequest(id: string) {
  try {
    const { data, error } = await supabase
      .from('leave_requests')
      .delete()
      .eq('id', id)
      .eq('status', 'Pending')
      .select('id')
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('Yêu cầu không còn tồn tại hoặc đã được xử lý.');
    return ok('Đã xoá đơn!');
  } catch (error) {
    return err(error);
  }
}

export async function deleteExplanation(id: string) {
  try {
    const { data, error } = await supabase.rpc('delete_attendance_request_v3', { p_id: id });
    if (error) throw error;
    assertRpcSuccess(data, 'Không thể xoá giải trình.');
    return ok('Đã xoá giải trình!');
  } catch (error) {
    return err(error);
  }
}

export async function processRequest(id: string, status: DecisionStatus, note: string) {
  try {
    const { error } = await supabase.rpc('review_leave_request', { p_id: id, p_status: status, p_note: note });
    if (error) throw error;
    return ok('Đã xử lý!');
  } catch (error) {
    return err(error);
  }
}

export async function processExplanation(id: string, status: DecisionStatus, note: string) {
  try {
    const normalizedStatus = status === 'Approved' ? 'APPROVED' : 'REJECTED';
    const { error } = await supabase.rpc('review_attendance_request_v2', {
      p_id: id,
      p_status: normalizedStatus,
      p_note: note,
    });
    if (error) throw error;
    return ok('Đã xử lý!');
  } catch (error) {
    return err(error);
  }
}

export async function doCheckOut(position: { lat: number; lng: number; accuracy: number }) {
  try {
    const { lat, lng, accuracy } = position;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error('Vui lòng bật GPS.');
    if (!Number.isFinite(accuracy) || accuracy <= 0 || accuracy > TMS_LIMITS.MAX_GPS_ACCURACY_METERS) {
      throw new Error(`Tín hiệu GPS chưa đủ chính xác (${Math.round(accuracy)}m).`);
    }
    const { data, error } = await supabase.rpc('checkout_attendance_gps_v3', {
      p_lat: lat,
      p_lng: lng,
      p_accuracy: accuracy,
      p_device_id: getCurrentDeviceId(),
    });
    if (error) throw error;
    assertRpcSuccess(data, 'Check-out thất bại.');
    return ok(rpcText(data, 'message') || 'Check-out thành công!');
  } catch (error) {
    return err(error);
  }
}

export async function togglePause() {
  try {
    const { data, error } = await supabase.rpc('toggle_attendance_pause_v3');
    if (error) throw error;
    assertRpcSuccess(data, 'Không cập nhật được trạng thái tạm dừng.');
    return {
      success: true as const,
      message: rpcText(data, 'message') || 'Đã cập nhật trạng thái.',
      action: rpcText(data, 'action'),
    };
  } catch (error) {
    return err(error);
  }
}

function avatarBlob(value: Blob | string) {
  if (value instanceof Blob) return value;

  try {
    const separatorIndex = value.indexOf(',');
    const header = value.slice(0, separatorIndex);
    const payload = value.slice(separatorIndex + 1);
    if (separatorIndex < 0 || !header.startsWith('data:') || !header.endsWith(';base64') || !payload) {
      throw new Error('Invalid data URL');
    }

    const mimeType = header.slice('data:'.length, -';base64'.length);
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new Blob([bytes], { type: mimeType });
  } catch {
    throw new Error('Dữ liệu ảnh đại diện không hợp lệ. Vui lòng chọn lại ảnh.');
  }
}

export async function updateProfileAvatar(image: Blob | string) {
  try {
    const { data: authData, error: authError } = await supabase.auth.getUser();
    if (authError || !authData.user) throw new Error('Phiên đăng nhập không hợp lệ.');
    const avatar = avatarBlob(image);
    if (!TMS_STORAGE.AVATAR_MIME_TYPES.includes(avatar.type as typeof TMS_STORAGE.AVATAR_MIME_TYPES[number])) {
      throw new Error('Ảnh đại diện phải là JPEG, PNG hoặc WebP.');
    }
    if (avatar.size > TMS_LIMITS.MAX_AVATAR_STORAGE_BYTES) {
      throw new Error('Ảnh sau khi xử lý vẫn vượt quá dung lượng lưu trữ.');
    }

    const path = `${authData.user.id}/${TMS_STORAGE.AVATAR_FILE_NAME}`;
    const { error: uploadError } = await supabase.storage.from(TMS_STORAGE.AVATAR_BUCKET).upload(path, avatar, {
      contentType: avatar.type,
      cacheControl: String(TMS_STORAGE.AVATAR_CACHE_SECONDS),
      upsert: true,
    });
    if (uploadError) throw new Error(`Không thể tải ảnh lên kho lưu trữ: ${uploadError.message}`);
    const { data: publicUrlData } = supabase.storage.from(TMS_STORAGE.AVATAR_BUCKET).getPublicUrl(path);
    const avatarUrl = `${publicUrlData.publicUrl}?v=${Date.now()}`;
    const { error: profileError } = await supabase.rpc('set_my_avatar', { p_url: avatarUrl });
    if (profileError) throw new Error(`Ảnh đã tải lên nhưng chưa thể cập nhật hồ sơ: ${profileError.message}`);
    return { ...ok('Đã cập nhật ảnh đại diện.'), avatarUrl };
  } catch (error) {
    return err(error);
  }
}

export async function changePassword(oldPassword: string, newPassword: string) {
  try {
    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError || !userData.user?.email) throw new Error('Phiên đăng nhập không hợp lệ.');
    const { error: verificationError } = await supabase.auth.signInWithPassword({ email: userData.user.email, password: oldPassword });
    if (verificationError) throw new Error('Mật khẩu hiện tại không đúng.');
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) throw error;
    return ok('Đổi mật khẩu thành công.');
  } catch (error) {
    return err(error);
  }
}
