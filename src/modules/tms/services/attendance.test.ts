import { describe, expect, it } from 'vitest';
import { commandId, rpcError } from './attendance';

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
