import type { TabType } from '@/modules/tms/components/BottomNav';

export type EmployeeModalLayer =
  | 'settings'
  | 'settings-guide'
  | 'settings-support'
  | 'request'
  | 'explanation'
  | 'explanation-confirm'
  | 'qr'
  | 'checkout'
  | 'profile-password'
  | 'profile-logout'
  | 'profile-crop';

const TABS = new Set<TabType>([
  'home',
  'history',
  'requests',
  'calendar',
  'contacts',
  'manager',
  'profile',
  'notifications',
]);
const MODALS = new Set<EmployeeModalLayer>([
  'settings',
  'settings-guide',
  'settings-support',
  'request',
  'explanation',
  'explanation-confirm',
  'qr',
  'checkout',
  'profile-password',
  'profile-logout',
  'profile-crop',
]);

export interface EmployeeNavigationState {
  tab: TabType;
  modal: EmployeeModalLayer | null;
  requestType?: string;
  explanationDate?: string;
}

export function parseEmployeeNavigation(search: string): EmployeeNavigationState {
  const params = new URLSearchParams(search);
  const rawTab = params.get('tab');
  const rawModal = params.get('modal');
  const tab = rawTab && TABS.has(rawTab as TabType) ? rawTab as TabType : 'home';
  const modal = rawModal && MODALS.has(rawModal as EmployeeModalLayer)
    ? rawModal as EmployeeModalLayer
    : null;
  const requestType = params.get('requestType')?.slice(0, 80) || undefined;
  const explanationDateValue = params.get('date') || '';
  const explanationDate = /^\d{4}-\d{2}-\d{2}$/.test(explanationDateValue)
    ? explanationDateValue
    : undefined;
  return { tab, modal, requestType, explanationDate };
}

function clearEmployeeLayers(params: URLSearchParams) {
  params.delete('modal');
  params.delete('requestType');
  params.delete('date');
  return params;
}

export function employeeSearchForTab(search: string, tab: TabType) {
  const params = clearEmployeeLayers(new URLSearchParams(search));
  params.delete('historyView');
  params.delete('requestView');
  params.delete('calendarView');
  params.set('tab', tab);
  return `?${params.toString()}`;
}

export function employeeSearchForModal(
  search: string,
  modal: EmployeeModalLayer,
  options: { requestType?: string; explanationDate?: string } = {},
) {
  const params = clearEmployeeLayers(new URLSearchParams(search));
  params.set('modal', modal);
  if (options.requestType) params.set('requestType', options.requestType);
  if (options.explanationDate) params.set('date', options.explanationDate);
  return `?${params.toString()}`;
}

export function employeeSearchWithoutModal(search: string) {
  const params = clearEmployeeLayers(new URLSearchParams(search));
  const query = params.toString();
  return query ? `?${query}` : '';
}
