import { beforeEach, describe, expect, it, vi } from 'vitest';

const workforceMocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock('@/core/supabase', () => ({
  isSupabaseConfigured: true,
  supabase: { rpc: vi.fn() },
}));

vi.mock('./workforceApi', () => ({
  queryWorkforce: workforceMocks.query,
}));

import {
  getNotificationInbox,
  getNotificationUnreadCount,
  normalizeNotificationInbox,
} from './notifications';

beforeEach(() => {
  workforceMocks.query.mockReset();
});

describe('normalizeNotificationInbox', () => {
  it('maps the server inbox and uses the authoritative unread count', () => {
    const result = normalizeNotificationInbox({
      total: 2,
      rows: [
        {
          id: '10000000-0000-4000-8000-000000000001',
          kind: 'REQUEST_DECIDED',
          title: 'Yêu cầu đã được duyệt',
          body: 'Đã xử lý',
          context: { request_id: 'request-1' },
          created_at: '2026-09-15T08:00:00Z',
          read_at: null,
        },
        { id: null, created_at: null },
      ],
    }, { unread: 7 });

    expect(result.total).toBe(2);
    expect(result.unread).toBe(7);
    expect(result.items).toEqual([expect.objectContaining({
      id: '10000000-0000-4000-8000-000000000001',
      kind: 'REQUEST_DECIDED',
      readAt: null,
      context: { request_id: 'request-1' },
    })]);
  });

  it('returns a safe empty inbox for malformed payloads', () => {
    expect(normalizeNotificationInbox(null, { unread: -5 })).toEqual({ items: [], total: 0, unread: 0 });
  });

  it('loads only bootstrap when the closed header needs an unread badge', async () => {
    workforceMocks.query.mockResolvedValue({ unread: 3 });

    await expect(getNotificationUnreadCount('org-1:employee-1')).resolves.toBe(3);
    expect(workforceMocks.query).toHaveBeenCalledTimes(1);
    expect(workforceMocks.query).toHaveBeenCalledWith(
      'bootstrap',
      {},
      { scope: 'org-1:employee-1', force: false, ttlSeconds: 30 },
    );
  });

  it('loads inbox rows only for an explicit inbox refresh', async () => {
    workforceMocks.query.mockImplementation(async (resource: string) => resource === 'inbox'
      ? { total: 0, rows: [] }
      : { unread: 2 });

    await expect(getNotificationInbox('org-1:employee-1')).resolves.toEqual({
      items: [],
      total: 0,
      unread: 2,
    });
    expect(workforceMocks.query).toHaveBeenCalledTimes(2);
    expect(workforceMocks.query).toHaveBeenCalledWith(
      'inbox',
      { page: 1, size: 50 },
      { scope: 'org-1:employee-1', force: true },
    );
  });
});
