import { describe, expect, it } from 'vitest';
import type { DashboardData, Employee } from '@/shared/types';
import {
  createDashboardSnapshot,
  DASHBOARD_SNAPSHOT_TTL_MS,
  validateDashboardSnapshot,
} from './dashboardSnapshot';

const user: Employee = {
  id: 'employee-row',
  employee_id: 'EMP-001',
  organization_id: 'tenant-a',
  name: 'Nguyễn Văn A',
  email: 'a@example.test',
  role: 'Staff',
  center_id: 'DNO1',
  status: 'Active',
};

const dashboard = {
  userProfile: user,
  history: { history: [], summary: { workDays: 0, lateMins: 0, leaveDays: 0, remainingLeave: 12, standardDays: 22, errorCount: 0 } },
  notifications: { approvals: [{ id: 'team-request' }], explanationApprovals: [{ id: 'team-explanation' }], myRequests: [], myExplanations: [] },
  myRequests: [],
  myExplanations: [],
  teamLeaves: [{ id: 'team-leave' }],
  locations: [],
  locationDirectory: [],
  contacts: [{ ...user, employee_id: 'EMP-002', id: 'other-employee' }],
  holidays: [],
  shifts: [],
  systemConfig: { LATE_TOLERANCE: 0, MIN_HOURS_FULL: 8, MIN_HOURS_HALF: 4, LUNCH_START: '12:00', LUNCH_END: '13:00', OFF_DAYS: [], MAX_DISTANCE_METERS: 200 },
  approvalRoles: { leave: ['Manager'], attendance: ['Manager'] },
  capabilities: [],
} as unknown as DashboardData;

describe('dashboard offline snapshot', () => {
  const now = new Date('2026-09-15T08:00:00Z');

  it('keeps personal data but strips directory and team PII', () => {
    const snapshot = createDashboardSnapshot(user, dashboard, now);
    expect(snapshot?.data.contacts).toEqual([]);
    expect(snapshot?.data.teamLeaves).toEqual([]);
    expect(snapshot?.data.notifications.approvals).toEqual([]);
    expect(snapshot?.data.notifications.explanationApprovals).toEqual([]);
    expect(snapshot?.data.userProfile.employee_id).toBe('EMP-001');
  });

  it('rejects an expired or different-tenant snapshot', () => {
    const snapshot = createDashboardSnapshot(user, dashboard, now);
    expect(validateDashboardSnapshot(snapshot, user, now)).toEqual(snapshot);
    expect(validateDashboardSnapshot(snapshot, { ...user, organization_id: 'tenant-b' }, now)).toBeNull();
    expect(validateDashboardSnapshot(snapshot, user, new Date(now.getTime() + DASHBOARD_SNAPSHOT_TTL_MS + 1))).toBeNull();
  });
});
