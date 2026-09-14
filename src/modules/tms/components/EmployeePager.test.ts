import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { EmployeeNavTab } from './BottomNav';
import EmployeePager, {
  INITIAL_PAGER_TRANSITION_STATE,
  adjacentPagerIndex,
  reducePagerTransition,
} from './EmployeePager';

describe('EmployeePager', () => {
  it('renders the active page with only its immediate neighbours', () => {
    const renderPage = vi.fn((tab: EmployeeNavTab) => (
      createElement('div', { 'data-page': tab }, tab)
    ));

    const markup = renderToStaticMarkup(
      createElement(EmployeePager, {
        activeTab: 'calendar',
        navigationResetVersion: 0,
        onChange: vi.fn(),
        renderPage,
      }),
    );

    expect(renderPage).toHaveBeenCalledTimes(3);
    expect(renderPage).toHaveBeenCalledWith('calendar', true);
    expect(markup).toContain('data-active-tab="calendar"');
    expect(markup).toContain('data-page="requests"');
    expect(markup).toContain('data-page="calendar"');
    expect(markup).toContain('data-page="contacts"');
    expect(markup).not.toContain('data-page="home"');
    expect(markup).not.toContain('data-pager-phase');
  });

  it('moves by one tab and resists both outer boundaries', () => {
    expect(adjacentPagerIndex(2, 'left', 5)).toBe(3);
    expect(adjacentPagerIndex(2, 'right', 5)).toBe(1);
    expect(adjacentPagerIndex(0, 'right', 5)).toBeNull();
    expect(adjacentPagerIndex(4, 'left', 5)).toBeNull();
  });

  it('ignores a stale completion after an external navigation reset', () => {
    const dragging = reducePagerTransition(INITIAL_PAGER_TRANSITION_STATE, { type: 'drag' });
    const settling = reducePagerTransition(dragging, { type: 'settle', targetIndex: 4 });
    const staleGeneration = settling.generation;
    const reset = reducePagerTransition(settling, { type: 'reset' });
    const staleFinish = reducePagerTransition(reset, { type: 'finish', generation: staleGeneration });

    expect(reset).toEqual({ generation: staleGeneration + 1, phase: 'idle', targetIndex: null });
    expect(staleFinish).toBe(reset);
  });

  it('finishes only the current settling generation', () => {
    const settling = reducePagerTransition(INITIAL_PAGER_TRANSITION_STATE, { type: 'settle', targetIndex: 1 });
    const finished = reducePagerTransition(settling, { type: 'finish', generation: settling.generation });

    expect(finished).toEqual({ generation: settling.generation, phase: 'idle', targetIndex: null });
  });
});
