import { beforeEach, describe, expect, it, vi } from 'vitest';

const supabaseMocks = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock('@/core/supabase', () => ({
  supabase: { rpc: supabaseMocks.rpc },
}));

import { clearWorkforceResourceCache, isWorthPersisting, queryWorkforce } from './workforceApi';

beforeEach(() => {
  clearWorkforceResourceCache();
  supabaseMocks.rpc.mockReset();
});

describe('queryWorkforce request coalescing', () => {
  it('shares an identical in-flight read even when the second caller requires fresh data', async () => {
    let finish!: (value: { data: { version: number }; error: null }) => void;
    supabaseMocks.rpc.mockReturnValue(new Promise((resolve) => { finish = resolve; }));

    const first = queryWorkforce('bootstrap', {}, { scope: 'org-1:employee-1' });
    const forced = queryWorkforce('bootstrap', {}, { scope: 'org-1:employee-1', force: true });

    expect(supabaseMocks.rpc).toHaveBeenCalledTimes(1);
    finish({ data: { version: 4 }, error: null });
    await expect(Promise.all([first, forced])).resolves.toEqual([{ version: 4 }, { version: 4 }]);
  });

  it('does not share reads across tenant/user scopes', async () => {
    supabaseMocks.rpc.mockResolvedValue({ data: { version: 4 }, error: null });

    await Promise.all([
      queryWorkforce('bootstrap', {}, { scope: 'org-1:employee-1' }),
      queryWorkforce('bootstrap', {}, { scope: 'org-2:employee-1' }),
    ]);

    expect(supabaseMocks.rpc).toHaveBeenCalledTimes(2);
  });
});

describe('isWorthPersisting', () => {
  it('carries reference data across a restart', () => {
    // The server marks metadata, the directory and the schedule as good for
    // five minutes; those are the ones worth not asking for twice.
    expect(isWorthPersisting(300)).toBe(true);
    expect(isWorthPersisting(60)).toBe(true);
  });

  it('leaves short-lived data in memory, where freshness is the point', () => {
    // History and the request queue are on a 30-second leash from the server.
    expect(isWorthPersisting(30)).toBe(false);
    expect(isWorthPersisting(59)).toBe(false);
  });

  it('never persists a response the server gave no window for', () => {
    expect(isWorthPersisting(0)).toBe(false);
    expect(isWorthPersisting(-1)).toBe(false);
    expect(isWorthPersisting(Number.NaN)).toBe(false);
  });
});
