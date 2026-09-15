import { beforeEach, describe, expect, it, vi } from 'vitest';

const workforceMocks = vi.hoisted(() => ({
  query: vi.fn(),
  rows: vi.fn(),
}));

vi.mock('@/core/supabase', () => ({
  isSupabaseConfigured: true,
  supabase: {},
}));

vi.mock('./attendance', () => ({
  commandId: vi.fn(),
  runAttendanceAction: vi.fn(),
}));

vi.mock('@/core/observability/clientTelemetry', () => ({
  reportClientMetric: vi.fn(),
}));

vi.mock('./workforceApi', () => ({
  queryWorkforce: workforceMocks.query,
  queryWorkforceRows: workforceMocks.rows,
}));

import { getDashboardData } from './employee';

function bootstrap(capabilities: string[]) {
  return {
    profile: {
      employee_id: 'EMP-1',
      organization_id: 'org-1',
      auth_user_id: 'auth-1',
      name: 'Pilot User',
      email: 'pilot@example.com',
      role: capabilities.includes('attendance.review') ? 'Manager' : 'Staff',
      center_id: 'DN1',
      status: 'Active',
      annual_leave_balance: 12,
      allowed_locations: [],
      managed_locations: [],
    },
    capabilities,
    local_date: '2026-09-15',
    timezone: 'Asia/Ho_Chi_Minh',
    policy: { work_days: [1, 2, 3, 4, 5] },
    summary: {},
  };
}

beforeEach(() => {
  workforceMocks.query.mockReset();
  workforceMocks.rows.mockReset();
  workforceMocks.query.mockImplementation(async (resource: string) => resource === 'metadata'
    ? { shifts: [], locations: [], location_directory: [], holidays: [], system_settings: [] }
    : bootstrap([]));
  workforceMocks.rows.mockResolvedValue([]);
});

describe('getDashboardData read fan-out', () => {
  it('does not request a team approval queue for an employee without review capability', async () => {
    const result = await getDashboardData('EMP-1', { organizationId: 'org-1' });

    expect(result.success).toBe(true);
    expect(workforceMocks.query).toHaveBeenCalledWith(
      'bootstrap',
      {},
      { scope: 'org-1:EMP-1', force: undefined, ttlSeconds: 30 },
    );
    expect(workforceMocks.rows.mock.calls.filter(([, args]) => args.team === true)).toHaveLength(0);
  });

  it('retains the team queue for an authorized reviewer', async () => {
    workforceMocks.query.mockImplementation(async (resource: string) => resource === 'metadata'
      ? { shifts: [], locations: [], location_directory: [], holidays: [], system_settings: [] }
      : bootstrap(['team.read', 'attendance.review']));

    const result = await getDashboardData('EMP-1', { organizationId: 'org-1', force: true });

    expect(result.success).toBe(true);
    expect(workforceMocks.rows.mock.calls.filter(([, args]) => args.team === true)).toHaveLength(1);
  });
});
