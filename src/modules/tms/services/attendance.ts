import { supabase, isSupabaseConfigured } from '@/core/supabase';
import { getCurrentDeviceId } from '@/core/deviceBinding';
import { TMS_LIMITS } from '@/shared/constants';
import type {
  DynamicQrResult,
  WorkforceAttendanceResult,
  WorkforceReceipt,
} from '@/shared/types';

type AttendanceAction = WorkforceReceipt['action'];
type AttendanceIntentStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

interface AttendanceIntentRecord {
  version: 1;
  commandId: string;
  action: AttendanceAction;
  createdAt: number;
  expiresAt: number;
}

interface AttendanceRpcError {
  message: string;
  code?: string;
}

const ATTENDANCE_INTENT_VERSION = 1;
const ATTENDANCE_INTENT_KEY_PREFIX = 'genai:attendance-intent:v1';
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const ATTENDANCE_INTENT_TTL_MS = 30 * 60 * 1_000;

// Exported for direct unit testing (see attendance.test.ts) — this maps the server's
// RPC response shape to thrown errors, and a silent regression here would surface as
// misleading toast messages rather than a caught bug.
export function rpcError(error: { message: string } | null, data: unknown, operation: string) {
  if (error) throw new Error(error.message);
  if (!data || typeof data !== 'object') throw new Error(`${operation} không trả về dữ liệu hợp lệ.`);
  const payload = data as WorkforceAttendanceResult;
  if (payload.ok === false) throw new Error(payload.message || `${operation} thất bại.`);
}

// Exported for direct unit testing — generates the idempotency key sent with every
// attendance command; a malformed id would let a duplicate check-in slip through.
export function commandId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function attendanceIntentStorage() {
  try {
    return globalThis.localStorage as AttendanceIntentStorage | undefined;
  } catch {
    return undefined;
  }
}

function attendanceIntentKey(scope: string, action: AttendanceAction) {
  return `${ATTENDANCE_INTENT_KEY_PREFIX}:${encodeURIComponent(scope)}:${action}`;
}

function removeStoredIntent(storage: AttendanceIntentStorage, key: string) {
  try {
    storage.removeItem(key);
  } catch {
    // Storage is only a retry aid. Attendance must still work in private/restricted mode.
  }
}

function parseStoredIntent(
  storage: AttendanceIntentStorage,
  key: string,
  action: AttendanceAction,
  now: number,
) {
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<AttendanceIntentRecord>;
    const valid = value.version === ATTENDANCE_INTENT_VERSION
      && value.action === action
      && typeof value.commandId === 'string'
      && UUID_V4_PATTERN.test(value.commandId)
      && typeof value.createdAt === 'number'
      && Number.isFinite(value.createdAt)
      && value.createdAt <= now
      && typeof value.expiresAt === 'number'
      && Number.isFinite(value.expiresAt)
      && value.expiresAt > now
      && value.expiresAt - value.createdAt === ATTENDANCE_INTENT_TTL_MS;
    if (valid) return value as AttendanceIntentRecord;
  } catch {
    // Corrupt/unavailable storage is rotated below.
  }
  removeStoredIntent(storage, key);
  return null;
}

/**
 * Returns the durable idempotency key for one logical attendance action.
 * The persisted record deliberately contains no QR payload, device data or coordinates.
 */
export function acquireAttendanceCommandId(input: {
  scope: string;
  action: AttendanceAction;
  storage?: AttendanceIntentStorage | null;
  now?: number;
  generate?: () => string;
}) {
  const storage = input.storage === undefined ? attendanceIntentStorage() : input.storage || undefined;
  const now = input.now ?? Date.now();
  const generate = input.generate ?? commandId;
  if (!storage || !input.scope) return generate();

  const key = attendanceIntentKey(input.scope, input.action);
  const existing = parseStoredIntent(storage, key, input.action, now);
  if (existing) return existing.commandId;

  const next: AttendanceIntentRecord = {
    version: ATTENDANCE_INTENT_VERSION,
    commandId: generate(),
    action: input.action,
    createdAt: now,
    expiresAt: now + ATTENDANCE_INTENT_TTL_MS,
  };
  try {
    storage.setItem(key, JSON.stringify(next));
  } catch {
    // The generated command remains valid for this request even without persistence.
  }
  return next.commandId;
}

export function clearAttendanceCommandId(input: {
  scope: string;
  action: AttendanceAction;
  commandId: string;
  storage?: AttendanceIntentStorage | null;
}) {
  const storage = input.storage === undefined ? attendanceIntentStorage() : input.storage || undefined;
  if (!storage || !input.scope) return;
  const key = attendanceIntentKey(input.scope, input.action);
  try {
    const raw = storage.getItem(key);
    if (!raw) return;
    const value = JSON.parse(raw) as Partial<AttendanceIntentRecord>;
    // Do not let a late response from another tab clear a newer logical intent.
    if (value.commandId === input.commandId) removeStoredIntent(storage, key);
  } catch {
    removeStoredIntent(storage, key);
  }
}

/** A server rejection is final; a transport/protocol failure may hide a committed command. */
export function isTerminalAttendanceFailure(error: AttendanceRpcError | null, data: unknown) {
  if (data && typeof data === 'object' && (data as WorkforceAttendanceResult).ok === false) return true;
  const code = error?.code;
  return typeof code === 'string' && (/^[0-9A-Z]{5}$/.test(code) || /^PGRST\d{3}$/.test(code));
}

async function authenticatedAttendanceScope() {
  try {
    const { data } = await supabase.auth.getSession();
    // This ID only namespaces local retry state; the server remains the authority.
    return data.session?.user.id || null;
  } catch {
    return null;
  }
}

async function executeAttendanceCommand(
  action: AttendanceAction,
  args: Record<string, unknown>,
  operation: string,
  missingReceiptMessage: string,
) {
  const scope = await authenticatedAttendanceScope();
  const storage = attendanceIntentStorage();
  const durableCommandId = acquireAttendanceCommandId({ scope: scope || '', action, storage });
  const { data, error } = await supabase.rpc('workforce_command', {
    p_action: 'attendance',
    p_args: {
      ...args,
      action,
      command_id: durableCommandId,
    },
  });

  if (isTerminalAttendanceFailure(error, data) && scope) {
    clearAttendanceCommandId({ scope, action, commandId: durableCommandId, storage });
  }
  rpcError(error, data, operation);
  const result = data as WorkforceAttendanceResult;
  if (!result.receipt) {
    // Keep the command ID: an invalid/missing response is ambiguous and safe to replay.
    throw new Error(missingReceiptMessage);
  }
  if (scope) clearAttendanceCommandId({ scope, action, commandId: durableCommandId, storage });
  return { ...result, receipt: result.receipt };
}

export async function recordQrAttendance(input: {
  qrPayload: string;
  lat: number;
  lng: number;
  accuracy: number;
}): Promise<{ receipt: WorkforceReceipt; message: string }> {
  if (!isSupabaseConfigured) throw new Error('Chưa cấu hình Supabase.');
  const result = await executeAttendanceCommand('checkin', {
    device_id: getCurrentDeviceId(),
    qr_payload: input.qrPayload,
    lat: input.lat,
    lng: input.lng,
    accuracy: input.accuracy,
  }, 'Chấm công QR', 'Hệ thống chưa trả về biên nhận chấm công.');
  return { receipt: result.receipt, message: result.message || 'Hệ thống đã ghi nhận Check-in.' };
}

export async function runAttendanceAction(
  action: 'checkout',
  input: { lat: number; lng: number; accuracy: number },
): Promise<{ receipt: WorkforceReceipt; message: string }> {
  if (!isSupabaseConfigured) throw new Error('Chưa cấu hình Supabase.');
  const result = await executeAttendanceCommand(action, {
    device_id: getCurrentDeviceId(),
    lat: input.lat,
    lng: input.lng,
    accuracy: input.accuracy,
  }, 'Check-out', 'Hệ thống chưa trả về biên nhận thao tác.');
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

export function normalizeQrTimingConfig(payload: unknown) {
  const fallback = {
    refreshMs: TMS_LIMITS.QR_REFRESH_MS,
    validitySeconds: TMS_LIMITS.QR_VALIDITY_SECONDS,
  };
  const root = payload && typeof payload === 'object' ? payload as Record<string, unknown> : null;
  const timing = root?.qr_timing && typeof root.qr_timing === 'object'
    ? root.qr_timing as Record<string, unknown>
    : null;
  const refreshSeconds = Number(timing?.refresh_seconds);
  const validitySeconds = Number(timing?.validity_seconds);
  const validRefreshSeconds = Number.isFinite(refreshSeconds)
    ? Math.min(TMS_LIMITS.QR_REFRESH_MAX_SECONDS, Math.max(TMS_LIMITS.QR_REFRESH_MIN_SECONDS, refreshSeconds))
    : fallback.refreshMs / TMS_LIMITS.CLOCK_REFRESH_MS;
  const validValiditySeconds = Number.isFinite(validitySeconds)
    ? Math.min(TMS_LIMITS.QR_VALIDITY_MAX_SECONDS, Math.max(TMS_LIMITS.QR_VALIDITY_MIN_SECONDS, validitySeconds))
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

export async function getQrTimingConfig() {
  if (!isSupabaseConfigured) return normalizeQrTimingConfig(null);
  const { data, error } = await supabase.rpc('workforce_query', {
    p_resource: 'metadata',
    p_args: {},
  });
  return error ? normalizeQrTimingConfig(null) : normalizeQrTimingConfig(data);
}
