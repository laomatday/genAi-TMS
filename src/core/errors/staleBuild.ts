/**
 * Recovery for the one failure a deploy can inflict on a session that is
 * already open.
 *
 * Every route in this app is a dynamic import, and every build gives its chunks
 * new hashed names. A tab still running the previous build asks for a chunk that
 * the current deployment no longer serves, the import rejects, and React.lazy
 * throws inside render. That surfaces as an unhandled rejection immediately
 * followed by a render error — and pressing "Thử lại" only renders again, which
 * throws again, which is why it reads as a hard crash rather than a stale tab.
 *
 * Reloading fetches the current index.html and the chunk names that go with it,
 * so the fix is to reload rather than to re-render. The service worker's caches
 * are dropped on the way out, because assets are served cache-first and a stale
 * entry would otherwise survive the reload.
 */

/** Exported so a test can pre-seed it and observe the screen the user sees
 *  when automatic recovery has already been spent. */
export const STALE_RELOAD_MARKER = 'genai_tms_stale_build_reload_at';

/** Long enough that a reload loop cannot form, short enough that a second
 *  deploy later in the same session is still recovered automatically. */
const RELOAD_COOLDOWN_MS = 60_000;

function messageOf(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const candidate = error as { message?: unknown; name?: unknown };
    return [candidate.name, candidate.message].filter((part) => typeof part === 'string').join(' ');
  }
  return '';
}

/**
 * Recognises a failed module load across engines. Each browser words this
 * differently and none of them sets a machine-readable code, so the message is
 * all there is to go on.
 */
export function isStaleBuildError(error: unknown): boolean {
  const text = messageOf(error).toLowerCase();
  if (!text) return false;
  return (
    text.includes('chunkloaderror')
    // Chromium
    || text.includes('failed to fetch dynamically imported module')
    // Firefox
    || text.includes('error loading dynamically imported module')
    // Safari
    || text.includes('importing a module script failed')
    // Vite's own preload helper
    || text.includes('unable to preload css')
    || text.includes('failed to fetch dynamically imported')
  );
}

function readLastReload(storage: Pick<Storage, 'getItem'> | undefined): number {
  try {
    return Number(storage?.getItem(STALE_RELOAD_MARKER)) || 0;
  } catch {
    return 0;
  }
}

/** True when a recovery reload is allowed right now — i.e. we are not already
 *  in one. Exported for the tests, which is also the only way to prove the
 *  loop guard works without reloading a real page. */
export function shouldReloadForStaleBuild(
  storage: Pick<Storage, 'getItem' | 'setItem'> | undefined,
  now = Date.now(),
): boolean {
  if (now - readLastReload(storage) < RELOAD_COOLDOWN_MS) return false;
  try {
    storage?.setItem(STALE_RELOAD_MARKER, String(now));
  } catch {
    // Private modes throw on write. Recovering once without being able to
    // remember it is better than not recovering at all.
  }
  return true;
}

/** Drops the service worker and its caches so the reload cannot be answered
 *  from the build we are trying to leave behind. */
async function dropCachedBuild() {
  try {
    const registrations = 'serviceWorker' in navigator
      ? await navigator.serviceWorker.getRegistrations()
      : [];
    const cacheKeys = 'caches' in window ? await caches.keys() : [];
    await Promise.all([
      ...registrations.map((registration) => registration.unregister()),
      ...cacheKeys.map((key) => caches.delete(key)),
    ]);
  } catch {
    // A reload against the network is still worth attempting.
  }
}

/** Clears the cached build and reloads. Always reloads, even if clearing
 *  failed, because leaving the user on a dead screen is the worse outcome. */
export async function recoverFromStaleBuild() {
  await dropCachedBuild();
  window.location.reload();
}

/**
 * Recovers automatically when a module fails to load, before the failure ever
 * reaches a screen. Vite fires `vite:preloadError` for exactly this case.
 */
export function installStaleBuildRecovery() {
  if (typeof window === 'undefined') return;
  window.addEventListener('vite:preloadError', (event) => {
    // Handling it ourselves stops Vite rethrowing into an unhandled rejection.
    event.preventDefault();
    if (!shouldReloadForStaleBuild(globalThis.sessionStorage)) return;
    void recoverFromStaleBuild();
  });
}
