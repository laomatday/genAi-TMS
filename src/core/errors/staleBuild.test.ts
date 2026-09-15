import { describe, expect, it } from 'vitest';
import { isStaleBuildError, shouldReloadForStaleBuild } from './staleBuild';

describe('isStaleBuildError', () => {
  it('recognises the wording each engine uses for a missing module', () => {
    // Chromium — the message seen in production after a deploy.
    expect(isStaleBuildError(new Error('Failed to fetch dynamically imported module: https://x/assets/Manager-CgnmwQZt.js'))).toBe(true);
    // Firefox
    expect(isStaleBuildError(new Error('error loading dynamically imported module'))).toBe(true);
    // Safari
    expect(isStaleBuildError(new Error('Importing a module script failed.'))).toBe(true);
    // Vite's CSS preload helper
    expect(isStaleBuildError(new Error('Unable to preload CSS for /assets/index.css'))).toBe(true);
  });

  it('matches on the error name as well as the message', () => {
    const error = new Error('load failed');
    error.name = 'ChunkLoadError';
    expect(isStaleBuildError(error)).toBe(true);
  });

  it('leaves ordinary application errors alone', () => {
    expect(isStaleBuildError(new Error("Cannot read properties of undefined (reading 'map')"))).toBe(false);
    expect(isStaleBuildError(new Error('Không tìm thấy hồ sơ nhân viên.'))).toBe(false);
    expect(isStaleBuildError(null)).toBe(false);
    expect(isStaleBuildError(undefined)).toBe(false);
    expect(isStaleBuildError({})).toBe(false);
  });

  it('accepts a bare string, which is what window.onerror can hand over', () => {
    expect(isStaleBuildError('Failed to fetch dynamically imported module')).toBe(true);
  });
});

describe('shouldReloadForStaleBuild', () => {
  function memoryStorage(initial: Record<string, string> = {}) {
    const store = { ...initial };
    return {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => { store[key] = value; },
    };
  }

  it('allows the first recovery and blocks an immediate second one', () => {
    const storage = memoryStorage();
    const now = 1_000_000;
    expect(shouldReloadForStaleBuild(storage, now)).toBe(true);
    // This is the loop guard: without it the reloaded page hits the same dead
    // chunk, reloads again, and the app never settles.
    expect(shouldReloadForStaleBuild(storage, now + 500)).toBe(false);
    expect(shouldReloadForStaleBuild(storage, now + 59_000)).toBe(false);
  });

  it('allows recovery again once the cooldown has passed', () => {
    const storage = memoryStorage();
    const now = 1_000_000;
    expect(shouldReloadForStaleBuild(storage, now)).toBe(true);
    expect(shouldReloadForStaleBuild(storage, now + 61_000)).toBe(true);
  });

  it('still recovers when storage is unavailable', () => {
    // Private browsing throws on write; the app must not be left on a dead
    // screen just because it cannot record that it tried.
    const throwing = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
    };
    expect(shouldReloadForStaleBuild(throwing)).toBe(true);
    expect(shouldReloadForStaleBuild(undefined)).toBe(true);
  });
});
