import { describe, expect, it } from 'vitest';
import { resolveSwipeTarget } from './subPager';

const TABS = 5;

describe('resolveSwipeTarget', () => {
  it('moves between the page\'s own views before leaving the page', () => {
    // Đề xuất, on "Nghỉ phép", swiping left: the next view, not the next tab.
    expect(resolveSwipeTarget({ direction: 'left', tabIndex: 2, tabCount: TABS, sub: { index: 0, count: 2 } }))
      .toEqual({ kind: 'sub', index: 1 });
    expect(resolveSwipeTarget({ direction: 'right', tabIndex: 2, tabCount: TABS, sub: { index: 1, count: 2 } }))
      .toEqual({ kind: 'sub', index: 0 });
  });

  it('hands the gesture to the tab pager once the views run out', () => {
    // On the last view, swiping left continues to the next tab, so adjacent
    // tabs stay reachable by swipe rather than being walled off.
    expect(resolveSwipeTarget({ direction: 'left', tabIndex: 2, tabCount: TABS, sub: { index: 1, count: 2 } }))
      .toEqual({ kind: 'tab', index: 3 });
    expect(resolveSwipeTarget({ direction: 'right', tabIndex: 2, tabCount: TABS, sub: { index: 0, count: 2 } }))
      .toEqual({ kind: 'tab', index: 1 });
  });

  it('walks a longer list one view at a time', () => {
    // Danh bạ has one chip per branch, so the list is as long as the org.
    expect(resolveSwipeTarget({ direction: 'left', tabIndex: 4, tabCount: TABS, sub: { index: 3, count: 7 } }))
      .toEqual({ kind: 'sub', index: 4 });
  });

  it('behaves like a plain tab pager for a page with no views of its own', () => {
    expect(resolveSwipeTarget({ direction: 'left', tabIndex: 0, tabCount: TABS, sub: null }))
      .toEqual({ kind: 'tab', index: 1 });
    expect(resolveSwipeTarget({ direction: 'right', tabIndex: 0, tabCount: TABS, sub: null })).toBeNull();
  });

  it('ignores a single-view registration', () => {
    // A directory with one branch must not swallow the swipe.
    expect(resolveSwipeTarget({ direction: 'left', tabIndex: 1, tabCount: TABS, sub: { index: 0, count: 1 } }))
      .toEqual({ kind: 'tab', index: 2 });
  });

  it('stops at both ends of the whole pager', () => {
    expect(resolveSwipeTarget({ direction: 'right', tabIndex: 0, tabCount: TABS, sub: { index: 0, count: 2 } })).toBeNull();
    expect(resolveSwipeTarget({ direction: 'left', tabIndex: 4, tabCount: TABS, sub: { index: 1, count: 2 } })).toBeNull();
  });
});
