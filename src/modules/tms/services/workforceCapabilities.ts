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

export async function getEffectiveWorkforceCapabilities() {
  if (!isSupabaseConfigured) throw new Error('Chưa cấu hình Supabase.');
  const { data, error } = await supabase.rpc('workforce_query', {
    p_resource: 'bootstrap',
    p_args: {},
  });
  if (error) throw new Error(error.message || 'Không tải được quyền truy cập hiện hành.');
  return normalizeEffectiveCapabilities(data);
}
