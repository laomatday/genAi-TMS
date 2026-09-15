import { supabase } from '@/core/supabase';
import { TMS_LIMITS } from '@/shared/constants';

export type WorkforceResource = Record<string, unknown>;

interface ResourceCacheEntry<T> {
  expiresAt: number;
  value: T;
}

interface QueryOptions {
  /** Tenant + user identifier. Required before a response may be cached. */
  scope?: string;
  force?: boolean;
  ttlSeconds?: number;
}

interface ResourcePage<T> extends WorkforceResource {
  rows: T[];
  has_more?: boolean;
  next_cursor?: Record<string, unknown> | null;
  cache?: { ttl_seconds?: number };
}

const responseCache = new Map<string, ResourceCacheEntry<unknown>>();
const requestsInFlight = new Map<string, Promise<unknown>>();

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)]),
  );
}

function cacheKey(scope: string, resource: string, args: Record<string, unknown>) {
  return `${scope}:${resource}:${JSON.stringify(stableValue(args))}`;
}

function boundedTtlSeconds(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(TMS_LIMITS.RESOURCE_CACHE_MAX_SECONDS, Math.floor(parsed));
}

/**
 * Calls the only browser-readable Workforce API. Responses are cached in
 * memory per tenant/user/resource; no cross-login data is persisted.
 */
export async function queryWorkforce<T extends WorkforceResource = WorkforceResource>(
  resource: string,
  args: Record<string, unknown> = {},
  options: QueryOptions = {},
): Promise<T> {
  const key = options.scope ? cacheKey(options.scope, resource, args) : '';
  if (key && !options.force) {
    const cached = responseCache.get(key) as ResourceCacheEntry<T> | undefined;
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    if (cached) responseCache.delete(key);
  }
  // `force` bypasses a completed cache entry, not an identical request that is
  // already on the wire. Sharing that promise keeps pull-to-refresh fresh while
  // preventing independently mounted hooks from issuing the same RPC together.
  const pending = key ? requestsInFlight.get(key) as Promise<T> | undefined : undefined;
  if (pending) return pending;

  const request = (async () => {
    const { data, error } = await supabase.rpc('workforce_query', {
      p_resource: resource,
      p_args: args,
    });
    if (error) throw new Error(error.message || `Không tải được resource ${resource}.`);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error(`Resource ${resource} trả về dữ liệu không hợp lệ.`);
    }
    const value = data as T;
    const responseTtl = (value as WorkforceResource).cache;
    const ttl = boundedTtlSeconds(
      options.ttlSeconds
        ?? (responseTtl && typeof responseTtl === 'object'
          ? (responseTtl as Record<string, unknown>).ttl_seconds
          : 0),
    );
    if (key && ttl > 0) responseCache.set(key, { value, expiresAt: Date.now() + ttl * 1_000 });
    return value;
  })();

  if (key) requestsInFlight.set(key, request);
  try {
    return await request;
  } finally {
    if (key && requestsInFlight.get(key) === request) requestsInFlight.delete(key);
  }
}

/** Load a bounded keyset collection without ever falling back to offsets. */
export async function queryWorkforceRows<T extends WorkforceResource = WorkforceResource>(
  resource: string,
  args: Record<string, unknown> = {},
  options: QueryOptions & { maxPages?: number } = {},
): Promise<T[]> {
  const rows: T[] = [];
  let cursor: Record<string, unknown> | null = null;
  const seenCursors = new Set<string>();
  const maxPages = Math.min(
    TMS_LIMITS.RESOURCE_MAX_PAGES,
    Math.max(1, options.maxPages ?? TMS_LIMITS.RESOURCE_DEFAULT_MAX_PAGES),
  );

  for (let page = 0; page < maxPages; page += 1) {
    const response: ResourcePage<T> = await queryWorkforce<ResourcePage<T>>(
      resource,
      { ...args, size: TMS_LIMITS.RESOURCE_PAGE_SIZE, ...(cursor ? { cursor } : {}) },
      options,
    );
    if (!Array.isArray(response.rows)) throw new Error(`Resource ${resource} không có danh sách hợp lệ.`);
    rows.push(...response.rows);
    if (!response.has_more || !response.next_cursor) break;
    const serializedCursor = JSON.stringify(stableValue(response.next_cursor));
    if (seenCursors.has(serializedCursor)) throw new Error(`Cursor ${resource} không tiến về phía trước.`);
    seenCursors.add(serializedCursor);
    cursor = response.next_cursor;
  }
  return rows;
}

export function clearWorkforceResourceCache(scope?: string) {
  if (!scope) {
    responseCache.clear();
    requestsInFlight.clear();
    return;
  }
  const prefix = `${scope}:`;
  for (const key of responseCache.keys()) if (key.startsWith(prefix)) responseCache.delete(key);
  for (const key of requestsInFlight.keys()) if (key.startsWith(prefix)) requestsInFlight.delete(key);
}
