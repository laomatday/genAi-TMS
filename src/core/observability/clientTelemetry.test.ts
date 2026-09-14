import { describe, expect, it } from 'vitest';
import { normalizeTelemetryCode } from './clientTelemetry';

describe('normalizeTelemetryCode', () => {
  it('normalizes client codes to the Workforce telemetry contract', () => {
    expect(normalizeTelemetryCode(' dashboard load failed ')).toBe('DASHBOARD_LOAD_FAILED');
  });

  it('removes unsafe characters and caps the database payload', () => {
    expect(normalizeTelemetryCode('render:error/with details')).toBe('RENDER_ERROR_WITH_DETAILS');
    expect(normalizeTelemetryCode('x'.repeat(80))).toHaveLength(48);
  });

  it('uses a stable fallback for unusable input', () => {
    expect(normalizeTelemetryCode('!')).toBe('CLIENT_ERROR');
  });
});
