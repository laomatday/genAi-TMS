import { beforeEach, describe, expect, it, vi } from 'vitest';

const supabaseMocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock('@/core/supabase', () => ({
  isSupabaseConfigured: true,
  supabase: {
    auth: { getSession: supabaseMocks.getSession },
    rpc: supabaseMocks.rpc,
  },
}));

vi.mock('@/core/deviceBinding', () => ({
  getCurrentDeviceId: () => 'DEVICE-TEST',
}));

import {
  acquireAttendanceCommandId,
  ATTENDANCE_INTENT_TTL_MS,
  clearAttendanceCommandId,
  commandId,
  getQrTimingConfig,
  isTerminalAttendanceFailure,
  normalizeQrTimingConfig,
  recordQrAttendance,
  rpcError,
} from './attendance';

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  entries() {
    return [...this.values.entries()];
  }
}

const FIRST_COMMAND_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_COMMAND_ID = '22222222-2222-4222-8222-222222222222';

function qrInput() {
  return {
    qrPayload: 'secret-qr-payload',
    lat: 16.047079,
    lng: 108.20623,
    accuracy: 7,
  };
}

function receipt() {
  return {
    id: 'receipt-1',
    action: 'checkin' as const,
    occurred_at: '2026-09-15T08:00:00Z',
    work_date: '2026-09-15',
    work_session_id: 'session-1',
  };
}

beforeEach(() => {
  supabaseMocks.rpc.mockReset();
  supabaseMocks.getSession.mockReset();
  supabaseMocks.getSession.mockResolvedValue({
    data: { session: { user: { id: 'auth-user-1' } } },
    error: null,
  });
  vi.stubGlobal('localStorage', new MemoryStorage());
});

describe('commandId', () => {
  it('generates a well-formed v4 UUID', () => {
    const id = commandId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it('never repeats across calls', () => {
    const ids = new Set(Array.from({ length: 50 }, () => commandId()));
    expect(ids.size).toBe(50);
  });
});

describe('rpcError', () => {
  it('does not throw when there is no error and data looks ok', () => {
    expect(() => rpcError(null, { ok: true, receipt: {} }, 'Chấm công QR')).not.toThrow();
  });

  it('throws the transport error message when the RPC call itself failed', () => {
    expect(() => rpcError({ message: 'network down' }, null, 'Chấm công QR')).toThrow('network down');
  });

  it('throws a generic message when the RPC returns no usable payload', () => {
    expect(() => rpcError(null, null, 'Chấm công QR')).toThrow('Chấm công QR không trả về dữ liệu hợp lệ.');
    expect(() => rpcError(null, 'not-an-object', 'Chấm công QR')).toThrow('Chấm công QR không trả về dữ liệu hợp lệ.');
  });

  it('throws the server-provided message when the payload reports ok:false', () => {
    expect(() => rpcError(null, { ok: false, message: 'Thiết bị chưa được xác thực.' }, 'Chấm công QR'))
      .toThrow('Thiết bị chưa được xác thực.');
  });

  it('falls back to a generic failure message when ok:false has no message', () => {
    expect(() => rpcError(null, { ok: false }, 'Chấm công QR')).toThrow('Chấm công QR thất bại.');
  });
});

describe('durable attendance intent', () => {
  it('reuses the same command after reload until its TTL expires', () => {
    const storage = new MemoryStorage();
    const first = acquireAttendanceCommandId({
      scope: 'user-a',
      action: 'checkin',
      storage,
      now: 1_000,
      generate: () => FIRST_COMMAND_ID,
    });
    const afterReload = acquireAttendanceCommandId({
      scope: 'user-a',
      action: 'checkin',
      storage,
      now: 1_000 + ATTENDANCE_INTENT_TTL_MS - 1,
      generate: () => SECOND_COMMAND_ID,
    });
    const afterExpiry = acquireAttendanceCommandId({
      scope: 'user-a',
      action: 'checkin',
      storage,
      now: 1_000 + ATTENDANCE_INTENT_TTL_MS,
      generate: () => SECOND_COMMAND_ID,
    });

    expect(first).toBe(FIRST_COMMAND_ID);
    expect(afterReload).toBe(FIRST_COMMAND_ID);
    expect(afterExpiry).toBe(SECOND_COMMAND_ID);
  });

  it('scopes commands by user and action', () => {
    const storage = new MemoryStorage();
    const ids = [FIRST_COMMAND_ID, SECOND_COMMAND_ID, '33333333-3333-4333-8333-333333333333'];
    let index = 0;
    const generate = () => ids[index++]!;

    const checkinA = acquireAttendanceCommandId({ scope: 'user-a', action: 'checkin', storage, generate });
    const checkoutA = acquireAttendanceCommandId({ scope: 'user-a', action: 'checkout', storage, generate });
    const checkinB = acquireAttendanceCommandId({ scope: 'user-b', action: 'checkin', storage, generate });

    expect(new Set([checkinA, checkoutA, checkinB]).size).toBe(3);
  });

  it('only clears the matching command so a late tab cannot erase a newer intent', () => {
    const storage = new MemoryStorage();
    acquireAttendanceCommandId({
      scope: 'user-a',
      action: 'checkin',
      storage,
      generate: () => FIRST_COMMAND_ID,
    });

    clearAttendanceCommandId({
      scope: 'user-a',
      action: 'checkin',
      commandId: SECOND_COMMAND_ID,
      storage,
    });
    expect(acquireAttendanceCommandId({
      scope: 'user-a',
      action: 'checkin',
      storage,
      generate: () => SECOND_COMMAND_ID,
    })).toBe(FIRST_COMMAND_ID);

    clearAttendanceCommandId({
      scope: 'user-a',
      action: 'checkin',
      commandId: FIRST_COMMAND_ID,
      storage,
    });
    expect(acquireAttendanceCommandId({
      scope: 'user-a',
      action: 'checkin',
      storage,
      generate: () => SECOND_COMMAND_ID,
    })).toBe(SECOND_COMMAND_ID);
  });

  it('retains a command across an ambiguous transport failure and clears it after receipt', async () => {
    const storage = globalThis.localStorage as unknown as MemoryStorage;
    supabaseMocks.rpc
      .mockResolvedValueOnce({ data: null, error: { message: 'Failed to fetch' } })
      .mockResolvedValueOnce({ data: { ok: true, receipt: receipt() }, error: null });

    await expect(recordQrAttendance(qrInput())).rejects.toThrow('Failed to fetch');
    const firstArgs = supabaseMocks.rpc.mock.calls[0]?.[1].p_args;
    const stored = storage.entries();
    expect(stored).toHaveLength(1);
    expect(Object.keys(JSON.parse(stored[0]![1])).sort()).toEqual([
      'action',
      'commandId',
      'createdAt',
      'expiresAt',
      'version',
    ]);
    expect(stored[0]![1]).not.toContain(qrInput().qrPayload);

    await expect(recordQrAttendance(qrInput())).resolves.toMatchObject({ receipt: { id: 'receipt-1' } });
    const retryArgs = supabaseMocks.rpc.mock.calls[1]?.[1].p_args;
    expect(retryArgs.command_id).toBe(firstArgs.command_id);
    expect(storage.entries()).toHaveLength(0);
  });

  it('clears a definitive business failure so the next intent gets a new command', async () => {
    supabaseMocks.rpc
      .mockResolvedValueOnce({ data: { ok: false, message: 'QR đã hết hạn.' }, error: null })
      .mockResolvedValueOnce({ data: { ok: true, receipt: receipt() }, error: null });

    await expect(recordQrAttendance(qrInput())).rejects.toThrow('QR đã hết hạn.');
    await recordQrAttendance(qrInput());

    const firstId = supabaseMocks.rpc.mock.calls[0]?.[1].p_args.command_id;
    const nextId = supabaseMocks.rpc.mock.calls[1]?.[1].p_args.command_id;
    expect(nextId).not.toBe(firstId);
  });
});

describe('attendance failure classification', () => {
  it('treats business responses and database/PostgREST errors as final', () => {
    expect(isTerminalAttendanceFailure(null, { ok: false })).toBe(true);
    expect(isTerminalAttendanceFailure({ message: 'forbidden', code: '42501' }, null)).toBe(true);
    expect(isTerminalAttendanceFailure({ message: 'missing RPC', code: 'PGRST202' }, null)).toBe(true);
  });

  it('keeps retry state for transport and malformed responses', () => {
    expect(isTerminalAttendanceFailure({ message: 'Failed to fetch' }, null)).toBe(false);
    expect(isTerminalAttendanceFailure(null, { ok: true })).toBe(false);
  });
});

describe('QR timing query contract', () => {
  it('normalizes metadata qr_timing and enforces the refresh safety window', () => {
    expect(normalizeQrTimingConfig({
      qr_timing: { refresh_seconds: 20, validity_seconds: 60 },
    })).toEqual({ refreshMs: 20_000, validitySeconds: 60 });
    expect(normalizeQrTimingConfig({
      qr_timing: { refresh_seconds: 240, validity_seconds: 15 },
    })).toEqual({ refreshMs: 10_000, validitySeconds: 15 });
    expect(normalizeQrTimingConfig(null)).toEqual({ refreshMs: 30_000, validitySeconds: 45 });
  });

  it('uses workforce_query metadata instead of reading config_system directly', async () => {
    supabaseMocks.rpc.mockResolvedValue({
      data: { qr_timing: { refresh_seconds: 25, validity_seconds: 50 } },
      error: null,
    });

    await expect(getQrTimingConfig()).resolves.toEqual({ refreshMs: 25_000, validitySeconds: 50 });
    expect(supabaseMocks.rpc).toHaveBeenCalledWith('workforce_query', {
      p_resource: 'metadata',
      p_args: {},
    });
  });
});
