import { describe, expect, it } from 'vitest';
import {
  getDeviceLabel,
  hasServerVerifiedDeviceGrant,
  isServerAuthorizedDeviceExemption,
} from './deviceBinding';

const UA = {
  androidChrome: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36',
  iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  windowsEdge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0',
  macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  linuxFirefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0',
} as const;

describe('getDeviceLabel', () => {
  it('labels an Android phone running Chrome', () => {
    expect(getDeviceLabel(UA.androidChrome)).toBe('Chrome · Android');
  });

  it('labels an iPhone running Safari', () => {
    expect(getDeviceLabel(UA.iphoneSafari)).toBe('Safari · iPhone/iPad');
  });

  it('prefers Edge over Chrome when both tokens are present', () => {
    expect(getDeviceLabel(UA.windowsEdge)).toBe('Edge · Windows');
  });

  it('labels a Mac running Safari', () => {
    expect(getDeviceLabel(UA.macSafari)).toBe('Safari · macOS');
  });

  it('labels a Linux desktop running Firefox', () => {
    expect(getDeviceLabel(UA.linuxFirefox)).toBe('Firefox · Linux');
  });

  it('falls back to generic labels for an unrecognized user agent', () => {
    expect(getDeviceLabel('some-unknown-client/1.0')).toBe('Browser · Thiết bị');
  });
});

describe('isServerAuthorizedDeviceExemption', () => {
  it('honors an explicit exemption returned by the trusted-device service', () => {
    expect(isServerAuthorizedDeviceExemption({ ok: true, state: 'EXEMPT' })).toBe(true);
  });

  it('does not infer an exemption from a successful non-exempt state', () => {
    expect(isServerAuthorizedDeviceExemption({ ok: true, state: 'ACTIVE' })).toBe(false);
  });

  it('fails closed when an exempt state is returned with a failed result', () => {
    expect(isServerAuthorizedDeviceExemption({ ok: false, state: 'EXEMPT' })).toBe(false);
  });

  it('fails closed for an empty or malformed service response', () => {
    expect(isServerAuthorizedDeviceExemption(null)).toBe(false);
    expect(isServerAuthorizedDeviceExemption({ state: 'EXEMPT' })).toBe(false);
  });
});

describe('hasServerVerifiedDeviceGrant', () => {
  const now = Date.parse('2026-09-15T08:00:00.000Z');

  it('allows a server-verified device grant that is still valid', () => {
    expect(hasServerVerifiedDeviceGrant({
      ok: true,
      state: 'VERIFIED',
      expiresAt: '2026-09-15T09:00:00.000Z',
    }, now)).toBe(true);
  });

  it('requires a VERIFIED state and a future server expiry', () => {
    expect(hasServerVerifiedDeviceGrant({
      ok: true,
      state: 'ACTIVE',
      expiresAt: '2026-09-15T09:00:00.000Z',
    }, now)).toBe(false);
    expect(hasServerVerifiedDeviceGrant({
      ok: true,
      state: 'VERIFIED',
      expiresAt: '2026-09-15T07:59:59.000Z',
    }, now)).toBe(false);
    expect(hasServerVerifiedDeviceGrant({ ok: true, state: 'VERIFIED' }, now)).toBe(false);
  });
});
