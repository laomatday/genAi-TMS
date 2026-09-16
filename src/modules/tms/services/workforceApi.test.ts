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
  it('carries the tenant reference data across a restart', () => {
    // Shifts, locations, holidays and schedule templates: the server marks them
    // good for five minutes and they name nobody.
    expect(isWorthPersisting('metadata', 300)).toBe(true);
    expect(isWorthPersisting('metadata', 60)).toBe(true);
  });

  it('never writes colleague data to the device, however long its window', () => {
    // The dashboard snapshot strips contacts and team queues before storing,
    // so a shared phone or a station keeps nobody else's details. A cache that
    // wrote them anyway would undo that.
    expect(isWorthPersisting('directory', 300)).toBe(false);
    expect(isWorthPersisting('requests', 300)).toBe(false);
    expect(isWorthPersisting('inbox', 300)).toBe(false);
    expect(isWorthPersisting('admin.people', 300)).toBe(false);
    expect(isWorthPersisting('history', 300)).toBe(false);
  });

  it('leaves short-lived data in memory, where freshness is the point', () => {
    expect(isWorthPersisting('metadata', 30)).toBe(false);
    expect(isWorthPersisting('metadata', 59)).toBe(false);
  });

  it('never persists a response the server gave no window for', () => {
    expect(isWorthPersisting('metadata', 0)).toBe(false);
    expect(isWorthPersisting('metadata', -1)).toBe(false);
    expect(isWorthPersisting('metadata', Number.NaN)).toBe(false);
  });
});
