import { isSupabaseConfigured, supabase } from '@/core/supabase';
import { TMS_LIMITS } from '@/shared/constants';
import { queryWorkforce } from './workforceApi';

export interface WorkforceNotification {
  id: string;
  kind: string;
  title: string;
  body: string;
  context: Record<string, unknown>;
  createdAt: string;
  readAt: string | null;
}

export interface NotificationInbox {
  items: WorkforceNotification[];
  total: number;
  unread: number;
}

type DataRow = Record<string, unknown>;
const BOOTSTRAP_TTL_SECONDS = Math.ceil(TMS_LIMITS.DASHBOARD_VISIBLE_STALE_MS / 1_000);

function asRow(value: unknown): DataRow {
  return value && typeof value === 'object' ? value as DataRow : {};
}

function asNumber(value: unknown) {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

function mapNotification(value: unknown): WorkforceNotification | null {
  const row = asRow(value);
  const id = typeof row.id === 'string' ? row.id : '';
  const createdAt = typeof row.created_at === 'string' ? row.created_at : '';
  if (!id || !createdAt || !Number.isFinite(Date.parse(createdAt))) return null;
  return {
    id,
    kind: typeof row.kind === 'string' ? row.kind : 'GENERAL',
    title: typeof row.title === 'string' ? row.title : 'Thông báo',
    body: typeof row.body === 'string' ? row.body : '',
    context: asRow(row.context),
    createdAt,
    readAt: typeof row.read_at === 'string' ? row.read_at : null,
  };
}

export function normalizeNotificationInbox(inboxPayload: unknown, bootstrapPayload: unknown): NotificationInbox {
  const inbox = asRow(inboxPayload);
  const bootstrap = asRow(bootstrapPayload);
  const rows = Array.isArray(inbox.rows) ? inbox.rows : [];
  return {
    items: rows.map(mapNotification).filter((item): item is WorkforceNotification => item !== null),
    total: asNumber(inbox.total),
    unread: Math.max(0, asNumber(bootstrap.unread)),
  };
}

export async function getNotificationUnreadCount(scope: string, force = false): Promise<number> {
  if (!isSupabaseConfigured) throw new Error('Chưa cấu hình Supabase.');
  const bootstrap = await queryWorkforce('bootstrap', {}, {
    scope,
    force,
    ttlSeconds: BOOTSTRAP_TTL_SECONDS,
  });
  return Math.max(0, asNumber(bootstrap.unread));
}

export async function getNotificationInbox(scope: string, page = 1, size = 50): Promise<NotificationInbox> {
  if (!isSupabaseConfigured) throw new Error('Chưa cấu hình Supabase.');
  const [inbox, bootstrap] = await Promise.all([
    queryWorkforce('inbox', { page, size }, { scope, force: true }),
    queryWorkforce('bootstrap', {}, {
      scope,
      force: true,
      ttlSeconds: BOOTSTRAP_TTL_SECONDS,
    }),
  ]);
  return normalizeNotificationInbox(inbox, bootstrap);
}

export async function markNotificationRead(id?: string): Promise<number> {
  if (!isSupabaseConfigured) throw new Error('Chưa cấu hình Supabase.');
  const { data, error } = await supabase.rpc('workforce_command', {
    p_action: 'notification.read',
    p_args: id ? { id } : { all: true },
  });
  if (error) throw new Error(error.message || 'Không cập nhật được thông báo.');
  const payload = asRow(data);
  if (payload.ok !== true) throw new Error('Không cập nhật được thông báo.');
  return asNumber(payload.count);
}
