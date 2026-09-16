import { supabase } from '@/core/supabase';
import {
  readClientState,
  removeClientState,
  removeClientStateByPrefix,
  writeClientState,
} from '@/shared/storage/clientPersistence';
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

/**
 * Shortest window worth writing to disk.
 *
 * The cache above lives in memory, so it is gone the moment the app is closed —
 * which is every morning, for everyone, at once. Reference data the server
 * marks as good for minutes is written through to IndexedDB so reopening the
 * app reads it instead of asking a database that has no CPU headroom to spare.
 * Anything the server keeps on a short leash (today's timesheet, the request
 * queue) stays in memory only, because freshness is the point of those.
 */
const PERSISTED_MIN_TTL_SECONDS = 60;

/**
 * The only resources allowed onto the device.
 *
 * An allowlist rather than a denylist, because the cost of getting this wrong
 * is colleague data left on a phone that gets handed over or a station anyone
 * can walk up to. `metadata` is the tenant's reference data — shifts,
 * locations, holidays, schedule templates — and names nobody.
 *
 * The directory, the request queues and everything under `admin.` carry other
 * people's details and stay in memory, which is the same line the dashboard
 * snapshot draws when it strips contacts and team queues before storing.
 */
const PERSISTABLE_RESOURCES: ReadonlySet<string> = new Set(['metadata']);

/** Whether a response may be carried across a restart on this device. */
export function isWorthPersisting(resource: string, ttlSeconds: number): boolean {
  if (!PERSISTABLE_RESOURCES.has(resource)) return false;
  return Number.isFinite(ttlSeconds) && ttlSeconds >= PERSISTED_MIN_TTL_SECONDS;
}

/** Namespaced so clearing client state never has to guess what is a cache. */
function persistedKey(key: string) {
  return `workforce-cache:${key}`;
}

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

async function readPersistedEntry<T>(key: string): Promise<ResourceCacheEntry<T> | null> {
  try {
    const stored = await readClientState<ResourceCacheEntry<T>>(persistedKey(key));
    if (!stored || typeof stored !== 'object' || typeof stored.expiresAt !== 'number') return null;
    if (stored.expiresAt > Date.now()) return stored;
    void removeClientState(persistedKey(key));
    return null;
  } catch {
    // A cache that cannot be read is simply a miss.
    return null;
  }
}

/**
 * Files a response the caller already holds, so the next reader of the same
 * resource does not fetch it again.
 *
 * Sign-in reads `bootstrap` directly — it has to check the profile against the
 * authenticated user before anything else may run — and the dashboard then read
 * the identical resource a moment later because that first response never
 * reached the cache. On a database with no CPU headroom that second call is not
 * free.
 */
export function primeWorkforceCache(
  resource: string,
  value: WorkforceResource,
  options: { scope: string; args?: Record<string, unknown>; ttlSeconds?: number },
) {
  if (!options.scope) return;
  const ttl = boundedTtlSeconds(
    options.ttlSeconds
      ?? (value.cache && typeof value.cache === 'object'
        ? (value.cache as Record<string, unknown>).ttl_seconds
        : 0),
  );
  if (ttl <= 0) return;
  responseCache.set(cacheKey(options.scope, resource, options.args ?? {}), {
    value,
    expiresAt: Date.now() + ttl * 1_000,
  });
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

    // Nothing in memory: this may be a fresh start rather than a first-ever
    // read. The key carries the tenant and the employee, so a stored entry can
    // only ever be this user's own.
    const stored = PERSISTABLE_RESOURCES.has(resource) ? await readPersistedEntry<T>(key) : null;
    if (stored) {
      responseCache.set(key, stored);
      return stored.value;
    }
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
    if (key && ttl > 0) {
      const entry = { value, expiresAt: Date.now() + ttl * 1_000 };
      responseCache.set(key, entry);
      if (isWorthPersisting(resource, ttl)) void writeClientState(persistedKey(key), entry);
    }
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
  // The written-through copy has to go with it. An admin who changes a shift
  // clears the cache to see the change; leaving the copy on disk would show
  // them the old one again on their next restart.
  if (!scope) {
    responseCache.clear();
    requestsInFlight.clear();
    void removeClientStateByPrefix(persistedKey(''));
    return;
  }
  const prefix = `${scope}:`;
  for (const key of responseCache.keys()) if (key.startsWith(prefix)) responseCache.delete(key);
  for (const key of requestsInFlight.keys()) if (key.startsWith(prefix)) requestsInFlight.delete(key);
  void removeClientStateByPrefix(persistedKey(prefix));
}
