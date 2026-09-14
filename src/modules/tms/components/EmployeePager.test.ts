import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { EmployeeNavTab } from './BottomNav';
import EmployeePager from './EmployeePager';

describe('EmployeePager', () => {
  it('renders only the screen selected from the bottom navigation', () => {
    const renderPage = vi.fn((tab: EmployeeNavTab) => (
      createElement('div', { 'data-page': tab }, tab)
    ));

    const markup = renderToStaticMarkup(
      createElement(EmployeePager, { activeTab: 'calendar', renderPage }),
    );

    expect(renderPage).toHaveBeenCalledTimes(1);
    expect(renderPage).toHaveBeenCalledWith('calendar', true);
    expect(markup).toContain('data-active-tab="calendar"');
    expect(markup).toContain('data-page="calendar"');
    expect(markup).not.toContain('data-page="contacts"');
    expect(markup).not.toContain('data-pager-phase');
  });
});
