import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';

/**
 * Lets a page put its own segmented views on the swipe gesture that already
 * moves between the five bottom-bar tabs.
 *
 * Three pages carry a segmented control of their own — Lịch sử công has
 * Tuần/Tháng, Đề xuất has Nghỉ phép/Giải trình, Danh bạ has one chip per
 * branch — and a swipe used to skip straight past them to the next tab.
 *
 * The rule is the one a nested pager usually follows: a swipe moves within the
 * page's own views, and only once there is nothing left in that direction does
 * it hand the gesture on to the tab pager. Every view therefore stays reachable
 * by swipe, and the adjacent tabs stay reachable from the edges.
 */

export interface SubPagerPosition {
  index: number;
  count: number;
}

export type SwipeResolution =
  | { kind: 'sub'; index: number }
  | { kind: 'tab'; index: number }
  | null;

/**
 * Decides what a completed swipe should move. Pure, because this is the rule
 * worth testing — the rest is event plumbing.
 */
export function resolveSwipeTarget(options: {
  direction: 'left' | 'right';
  tabIndex: number;
  tabCount: number;
  sub: SubPagerPosition | null;
}): SwipeResolution {
  const step = options.direction === 'left' ? 1 : -1;
  const sub = options.sub;
  if (sub && sub.count > 1) {
    const nextSub = sub.index + step;
    if (nextSub >= 0 && nextSub < sub.count) return { kind: 'sub', index: nextSub };
  }
  const nextTab = options.tabIndex + step;
  if (nextTab >= 0 && nextTab < options.tabCount) return { kind: 'tab', index: nextTab };
  return null;
}

interface Registration extends SubPagerPosition {
  select: (index: number) => void;
}

export interface SubPagerRegistry {
  /** Which page owns the registration. Neighbours are mounted either side of
   *  the active page, so ownership is what stops an inactive one clearing it. */
  owner: object | null;
  value: Registration | null;
}

const SubPagerContext = createContext<SubPagerRegistry | null>(null);

export function SubPagerProvider({ registry, children }: { registry: SubPagerRegistry; children: ReactNode }) {
  return <SubPagerContext.Provider value={registry}>{children}</SubPagerContext.Provider>;
}

export function createSubPagerRegistry(): SubPagerRegistry {
  return { owner: null, value: null };
}

/**
 * Registers the calling page's segmented views with the pager above it.
 *
 * Deliberately has no dependency array: the index changes on almost every
 * render, and a stale index would send the swipe to the wrong view.
 */
export function useSubPager(options: {
  enabled: boolean;
  index: number;
  count: number;
  onSelect: (index: number) => void;
}) {
  const registry = useContext(SubPagerContext);
  const tokenRef = useRef({});

  useEffect(() => {
    if (!registry) return undefined;
    const token = tokenRef.current;
    const release = () => {
      if (registry.owner !== token) return;
      registry.owner = null;
      registry.value = null;
    };
    if (!options.enabled || options.count < 2) {
      release();
      return undefined;
    }
    registry.owner = token;
    registry.value = { index: options.index, count: options.count, select: options.onSelect };
    return release;
  });
}
