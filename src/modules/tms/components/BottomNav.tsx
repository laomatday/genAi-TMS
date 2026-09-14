import React from 'react';
import { motion } from 'framer-motion';
import { UI_MOTION } from '@/shared/constants';

export type TabType = 'home' | 'history' | 'requests' | 'contacts' | 'manager' | 'profile' | 'notifications' | 'calendar';

interface Props {
  activeTab: TabType;
  onChange: (tab: TabType) => void;
}

/** Labels must match the header title for the same tab (see TAB_IDENTITY in
 *  Header.tsx). They remain available to assistive technology and tooltips. */
const NAV_ITEMS: Array<{ name: TabType; icon: string; label: string }> = [
  { name: 'home', icon: 'home', label: 'Trang chủ' },
  { name: 'history', icon: 'history', label: 'Chấm công' },
  { name: 'requests', icon: 'description', label: 'Đề xuất' },
  { name: 'calendar', icon: 'calendar_month', label: 'Lịch' },
  { name: 'contacts', icon: 'group', label: 'Danh bạ' },
];

export const EMPLOYEE_NAV_TABS = NAV_ITEMS.map(({ name }) => name);

const NavItem = ({ name, icon, label, activeTab, onChange }: {
  name: TabType;
  icon: string;
  label: string;
  activeTab: TabType;
  onChange: (t: TabType) => void;
}) => {
  const isActive = activeTab === name;

  return (
    <button
      type="button"
      aria-label={label}
      aria-current={isActive ? 'page' : undefined}
      title={label}
      onClick={() => onChange(name)}
      className={`app-nav-item ${isActive ? 'app-nav-item-selected' : ''}`.trim()}
    >
      {isActive ? (
        <motion.span
          aria-hidden="true"
          layoutId="telegramGlassActiveTab"
          className="app-nav-track"
          transition={UI_MOTION.NAVIGATION_SPRING}
        />
      ) : null}
      <span className="app-nav-icon">
        <span className="material-symbols-rounded" aria-hidden="true">{icon}</span>
      </span>
    </button>
  );
};

const BottomNav: React.FC<Props> = ({ activeTab, onChange }) => (
  <div className="app-nav-container">
    <nav aria-label="Điều hướng chính" className="app-nav-shell">
      {NAV_ITEMS.map((item) => (
        <NavItem key={item.name} name={item.name} icon={item.icon} label={item.label} activeTab={activeTab} onChange={onChange} />
      ))}
    </nav>
  </div>
);

export default BottomNav;
