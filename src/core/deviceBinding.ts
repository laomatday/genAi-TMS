import { FunctionsHttpError } from '@supabase/supabase-js';
import { supabase, isSupabaseConfigured } from '@/core/supabase';
import { STORAGE_KEYS } from '@/shared/constants';
import { activationFromStatus, setDeviceActivation } from '@/core/deviceActivation';

const DEVICE_ID_KEY = STORAGE_KEYS.DEVICE_ID;
const DB_NAME = STORAGE_KEYS.DB_NAME;
const STORE_NAME = STORAGE_KEYS.STORE_NAME;
const PRIVATE_KEY_ID = 'private-key';

interface DeviceVerificationResult {
  ok: boolean;
  state?: 'EXEMPT' | 'NEEDS_ACTIVATION' | 'ACTIVE' | 'VERIFIED' | 'BLOCKED';
  needsActivation?: boolean;
  error?: string;
  message?: string;
  expiresAt?: string;
  challengeId?: string;
  challenge?: string;
  device?: {
    deviceId: string;
    label?: string | null;
    activatedAt?: string | null;
    lastSeenAt?: string | null;
  };
}

export function isServerAuthorizedDeviceExemption(
  result: unknown,
) {
  if (!result || typeof result !== 'object') return false;
  const candidate = result as Partial<DeviceVerificationResult>;
  return candidate.ok === true && candidate.state === 'EXEMPT';
}

export function hasServerVerifiedDeviceGrant(
  result: unknown,
  now = Date.now(),
) {
  if (!result || typeof result !== 'object') return false;
  const candidate = result as Partial<DeviceVerificationResult>;
  if (candidate.ok !== true || candidate.state !== 'VERIFIED' || !candidate.expiresAt) return false;
  const expiresAt = new Date(candidate.expiresAt).getTime();
  return Number.isFinite(expiresAt) && expiresAt > now;
}

function isDeviceVerificationResult(value: unknown): value is DeviceVerificationResult {
  return Boolean(value && typeof value === 'object' && typeof (value as { ok?: unknown }).ok === 'boolean');
}

function base64Url(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return reject(new Error('Trình duyệt không hỗ trợ lưu khóa thiết bị.'));
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Không mở được kho khóa thiết bị.'));
  });
}

async function readPrivateKey(): Promise<CryptoKey | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).get(PRIVATE_KEY_ID);
    request.onsuccess = () => resolve((request.result as CryptoKey | undefined) || null);
    request.onerror = () => reject(request.error || new Error('Không đọc được khóa thiết bị.'));
  });
}

async function writePrivateKey(key: CryptoKey) {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(key, PRIVATE_KEY_ID);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Không lưu được khóa thiết bị.'));
  });
}

function getLogicalDeviceId() {
  const existing = window.localStorage.getItem(DEVICE_ID_KEY);
  if (existing) return existing;
  if (!window.crypto?.getRandomValues) throw new Error('Trình duyệt không hỗ trợ tạo mã thiết bị an toàn.');
  const secureCrypto = window.crypto as Crypto & { randomUUID?: () => string };
  const suffix = typeof secureCrypto.randomUUID === 'function'
    ? secureCrypto.randomUUID()
    : Array.from(secureCrypto.getRandomValues(new Uint8Array(16)), (byte: number) => byte.toString(16).padStart(2, '0')).join('');
  const id = `DEV_${suffix}`;
  window.localStorage.setItem(DEVICE_ID_KEY, id);
  return id;
}

export function getCurrentDeviceId() {
  return getLogicalDeviceId();
}

// `userAgent` defaults to the real browser value; tests pass a fixture string directly
// so this stays a pure, unit-testable function (see deviceBinding.test.ts).
export function getDeviceLabel(userAgent: string = navigator.userAgent) {
  const ua = userAgent;
  const platform = /Android/i.test(ua) ? 'Android' : /iPhone|iPad|iPod/i.test(ua) ? 'iPhone/iPad' : /Windows/i.test(ua) ? 'Windows' : /Macintosh|Mac OS/i.test(ua) ? 'macOS' : /Linux/i.test(ua) ? 'Linux' : 'Thiết bị';
  const browser = /Edg\//i.test(ua) ? 'Edge' : /Chrome\//i.test(ua) ? 'Chrome' : /Safari\//i.test(ua) ? 'Safari' : /Firefox\//i.test(ua) ? 'Firefox' : 'Browser';
  return `${browser} · ${platform}`;
}

async function invokeDevice(body: Record<string, unknown>) {
  if (!isSupabaseConfigured) {
    return { ok: true, state: 'VERIFIED' } as DeviceVerificationResult;
  }
  const { data, error } = await supabase.functions.invoke('trusted-device', { body });
  if (error instanceof FunctionsHttpError) {
    try {
      const errorBody: unknown = await error.context.json();
      if (isDeviceVerificationResult(errorBody)) return errorBody;
    } catch {
      // Fall through to the SDK error when the function did not return JSON.
    }
  }
  if (error) throw new Error(error.message);
  if (!isDeviceVerificationResult(data)) {
    throw new Error('Dịch vụ xác thực thiết bị trả về dữ liệu không hợp lệ.');
  }
  return data;
}

export async function getDeviceBindingStatus() {
  const status = await invokeDevice({ action: 'status', deviceId: getLogicalDeviceId() });
  // Recorded here rather than in the gate so every caller of the status keeps
  // the shared answer current, and nothing needs a second round trip to ask.
  setDeviceActivation(activationFromStatus(status));
  return status;
}

export async function activateTrustedDevice() {
  if (!window.crypto?.subtle) throw new Error('Thiết bị không hỗ trợ WebCrypto.');
  const deviceId = getLogicalDeviceId();
  // For asymmetric WebCrypto keys, the private key honors extractable=false while
  // the public key remains exportable. The private signing key therefore cannot be
  // exported from IndexedDB by application code after creation.
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const publicKey = await crypto.subtle.exportKey('jwk', pair.publicKey);
  await writePrivateKey(pair.privateKey);
  const result = await invokeDevice({
    action: 'activate',
    deviceId,
    publicKey,
    deviceLabel: getDeviceLabel(),
    userAgent: navigator.userAgent,
  });
  if (!result.ok) throw new Error(result.error || 'Không kích hoạt được thiết bị.');
  const verified = await verifyTrustedDevice();
  setDeviceActivation('activated');
  return verified;
}

export async function verifyTrustedDevice() {
  const deviceId = getLogicalDeviceId();
  const privateKey = await readPrivateKey();
  if (!privateKey) throw new Error('Khóa bảo mật trên thiết bị đã bị mất. Vui lòng liên hệ Admin để đặt lại thiết bị.');
  const challenge = await invokeDevice({ action: 'challenge', deviceId });
  if (!challenge.ok || !challenge.challenge || !challenge.challengeId) throw new Error(challenge.error || 'Không tạo được yêu cầu xác thực thiết bị.');
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, new TextEncoder().encode(challenge.challenge));
  const verified = await invokeDevice({ action: 'verify', deviceId, challengeId: challenge.challengeId, signature: base64Url(signature) });
  if (!verified.ok) throw new Error(verified.error || 'Không xác thực được thiết bị.');
  return verified;
}

export async function resetTrustedDeviceAsAdmin(employeeId: string, reason: string) {
  const result = await invokeDevice({ action: 'admin-reset', employeeId, reason });
  if (!result.ok) throw new Error(result.error || 'Không đặt lại được thiết bị.');
  return result;
}
