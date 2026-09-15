import { describe, expect, it } from 'vitest';
import {
  employeeSearchForModal,
  employeeSearchForTab,
  employeeSearchWithoutModal,
  parseEmployeeNavigation,
} from './employeeNavigation';

describe('employee URL navigation', () => {
  it('rejects unknown route state and defaults to home', () => {
    expect(parseEmployeeNavigation('?tab=unknown&modal=unsafe&date=tomorrow')).toEqual({
      tab: 'home',
      modal: null,
      requestType: undefined,
      explanationDate: undefined,
    });
  });

  it('keeps tab state while adding and removing the top modal layer', () => {
    const modalSearch = employeeSearchForModal('?tab=requests', 'request', { requestType: 'Nghỉ phép' });
    expect(parseEmployeeNavigation(modalSearch)).toMatchObject({ tab: 'requests', modal: 'request', requestType: 'Nghỉ phép' });
    expect(employeeSearchWithoutModal(modalSearch)).toBe('?tab=requests');
  });

  it('clears modal-only parameters when navigating to another tab', () => {
    expect(employeeSearchForTab('?tab=requests&modal=explanation&date=2026-09-14', 'calendar')).toBe('?tab=calendar');
  });
});
