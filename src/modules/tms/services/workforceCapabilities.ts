import { isSupabaseConfigured, supabase } from '@/core/supabase';
import type { EmployeeRole } from '@/shared/types';

const CONTROL_CENTER_ENTRY_CAPABILITIES = new Set([
  'team.read',
  'attendance.export',
  'attendance.lock_period',
  'employee.manage',
  'schedule.manage',
  'settings.manage',
  'kiosk.manage',
  'audit.view',
]);

export function normalizeEffectiveCapabilities(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return [];
  const values = (payload as { capabilities?: unknown }).capabilities;
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0))];
}

export function hasControlCenterAccess(capabilities: readonly string[]) {
  return capabilities.some((capability) => CONTROL_CENTER_ENTRY_CAPABILITIES.has(capability));
}

export function canOpenKioskStation(role: EmployeeRole, capabilities: readonly string[]) {
  return role === 'Kiosk' || capabilities.includes('kiosk.manage');
}

/**
 * Sign-in already fetches `bootstrap`, and that one response carries the
 * capabilities as well as the profile. Handing them over here saves a second
 * round trip to the same RPC on every Control Center load.
 *
 * Deliberately short-lived and keyed to one subject: an admin who edits
 * capabilities must not be served a stale answer, and a different account
 * signing in on the same tab must never inherit the previous one's.
 */
const CAPABILITY_HANDOFF_TTL_MS = 30_000;
let handoff: { subject: string; capabilities: string[]; at: number } | null = null;

export function rememberEffectiveCapabilities(subject: string, payload: unknown) {
  if (!subject) return;
  handoff = { subject, capabilities: normalizeEffectiveCapabilities(payload), at: Date.now() };
}

export function forgetEffectiveCapabilities() {
  handoff = null;
}

/**
 * Consumes the handoff, or returns null when there is nothing safe to use.
 *
 * Exported for direct unit testing — this is the whole decision, and testing it
 * through the async wrapper would mean reaching the network on every miss.
 *
 * Single use in every outcome: a hit must not answer a later retry that exists
 * precisely because something changed, and a miss on subject or age means the
 * entry belongs to another account or another moment, which is never a value to
 * keep sitting in memory.
 */
export function takeCapabilityHandoff(subject: string): string[] | null {
  if (!handoff) return null;
  const usable = Boolean(subject)
    && handoff.subject === subject
    && Date.now() - handoff.at < CAPABILITY_HANDOFF_TTL_MS;
  const { capabilities } = handoff;
  handoff = null;
  return usable ? capabilities : null;
}

export async function getEffectiveWorkforceCapabilities(subject = '') {
  const handed = takeCapabilityHandoff(subject);
  if (handed) return handed;
  if (!isSupabaseConfigured) throw new Error('Chưa cấu hình Supabase.');
  const { data, error } = await supabase.rpc('workforce_query', {
    p_resource: 'bootstrap',
    p_args: {},
  });
  if (error) throw new Error(error.message || 'Không tải được quyền truy cập hiện hành.');
  return normalizeEffectiveCapabilities(data);
}
