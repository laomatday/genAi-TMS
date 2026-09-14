import { Suspense, type ReactNode } from 'react';
import type { EmployeeNavTab } from './BottomNav';

interface Props {
  activeTab: EmployeeNavTab;
  renderPage: (tab: EmployeeNavTab, isActive: boolean) => ReactNode;
}

/**
 * Hosts exactly one primary screen. Root navigation is deliberately explicit:
 * mounting neighbouring pages off-canvas made an interrupted touch/transition
 * capable of leaving two large screens visible at once on Android. Edge-swipe
 * back remains available inside supported full-screen modals.
 */
export default function EmployeePager({ activeTab, renderPage }: Props) {
  return (
    <div className="employee-pager" data-active-tab={activeTab}>
      <section key={activeTab} className="employee-pager-panel employee-pager-panel-current">
        <Suspense fallback={<div className="app-loading-screen" aria-label="Đang tải trang" />}>
          {renderPage(activeTab, true)}
        </Suspense>
      </section>
    </div>
  );
}
