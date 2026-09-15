import type { DashboardData, Employee } from '@/shared/types';
import { readClientState, removeClientState, writeClientState } from '@/shared/storage/clientPersistence';

const DASHBOARD_SNAPSHOT_SCHEMA_VERSION = 1;
export const DASHBOARD_SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1_000;

export interface DashboardSnapshot {
  schemaVersion: typeof DASHBOARD_SNAPSHOT_SCHEMA_VERSION;
  organizationId: string;
  employeeId: string;
  fetchedAt: string;
  expiresAt: string;
  data: DashboardData;
}

function identityOf(user: Pick<Employee, 'employee_id' | 'organization_id'>) {
  const organizationId = user.organization_id?.trim();
  const employeeId = user.employee_id.trim();
  if (!organizationId || !employeeId) return null;
  return { organizationId, employeeId };
}

function snapshotKey(user: Pick<Employee, 'employee_id' | 'organization_id'>) {
  const identity = identityOf(user);
  if (!identity) return null;
  return `dashboard:${encodeURIComponent(identity.organizationId)}:${encodeURIComponent(identity.employeeId)}`;
}

/** Keep only the signed-in employee's data. Team queues and the people directory
 * deliberately remain network-only so a shared device does not retain colleague PII. */
function minimizeDashboardForOffline(data: DashboardData): DashboardData {
  return {
    ...data,
    contacts: [],
    teamLeaves: [],
    notifications: {
      approvals: [],
      explanationApprovals: [],
      myRequests: [],
      myExplanations: [],
    },
  };
}

export function createDashboardSnapshot(
  user: Pick<Employee, 'employee_id' | 'organization_id'>,
  data: DashboardData,
  fetchedAt = new Date(),
): DashboardSnapshot | null {
  const identity = identityOf(user);
  if (!identity || Number.isNaN(fetchedAt.getTime())) return null;
  return {
    schemaVersion: DASHBOARD_SNAPSHOT_SCHEMA_VERSION,
    ...identity,
    fetchedAt: fetchedAt.toISOString(),
    expiresAt: new Date(fetchedAt.getTime() + DASHBOARD_SNAPSHOT_TTL_MS).toISOString(),
    data: minimizeDashboardForOffline(data),
  };
}

export function validateDashboardSnapshot(
  value: unknown,
  user: Pick<Employee, 'employee_id' | 'organization_id'>,
  now = new Date(),
): DashboardSnapshot | null {
  const identity = identityOf(user);
  if (!identity || !value || typeof value !== 'object') return null;
  const snapshot = value as Partial<DashboardSnapshot>;
  if (
    snapshot.schemaVersion !== DASHBOARD_SNAPSHOT_SCHEMA_VERSION
    || snapshot.organizationId !== identity.organizationId
    || snapshot.employeeId !== identity.employeeId
    || typeof snapshot.fetchedAt !== 'string'
    || typeof snapshot.expiresAt !== 'string'
    || !snapshot.data
    || typeof snapshot.data !== 'object'
  ) return null;
  const fetchedAt = Date.parse(snapshot.fetchedAt);
  const expiresAt = Date.parse(snapshot.expiresAt);
  if (
    !Number.isFinite(fetchedAt)
    || !Number.isFinite(expiresAt)
    || expiresAt - fetchedAt !== DASHBOARD_SNAPSHOT_TTL_MS
    || fetchedAt > now.getTime()
    || expiresAt <= now.getTime()
    || snapshot.data.userProfile?.organization_id !== identity.organizationId
    || snapshot.data.userProfile?.employee_id !== identity.employeeId
  ) return null;
  return snapshot as DashboardSnapshot;
}

export async function loadDashboardSnapshot(
  user: Pick<Employee, 'employee_id' | 'organization_id'>,
  now = new Date(),
) {
  const key = snapshotKey(user);
  if (!key) return null;
  const stored = await readClientState<unknown>(key);
  const snapshot = validateDashboardSnapshot(stored, user, now);
  if (!snapshot && stored) await removeClientState(key);
  return snapshot;
}

export async function saveDashboardSnapshot(
  user: Pick<Employee, 'employee_id' | 'organization_id'>,
  data: DashboardData,
  fetchedAt = new Date(),
) {
  const key = snapshotKey(user);
  const snapshot = createDashboardSnapshot(user, data, fetchedAt);
  if (key && snapshot) await writeClientState(key, snapshot);
}
