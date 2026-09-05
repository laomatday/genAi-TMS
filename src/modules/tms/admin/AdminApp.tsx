import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { APP_INFO, APP_ROUTES, UI_MOTION } from '@/shared/constants';
import Avatar from '@/shared/components/common/Avatar';
import type { Employee } from '@/shared/types';
import { toLocalMonthString } from '@/core/utils/helpers';
import { ADMIN_NAV, getAdminCapabilities, type AdminSection } from './constants';
import { monthRange } from './formatters';
import { getAdminData } from './adminService';
import type { AdminActionRunner, AdminData } from './types';
import AccountsSection from './components/AccountsSection';
import AttendanceSection from './components/AttendanceSection';
import AuditSection from './components/AuditSection';
import KiosksSection from './components/KiosksSection';
import OverviewSection from './components/OverviewSection';
import SettingsSection from './components/SettingsSection';
import SchedulingSection from './components/SchedulingSection';

function todayInVietnam() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function AdminAccountMenu({
  user,
  onOpenWorkspace,
  onOpenAttendance,
  onLogout,
}: {
  user: Employee;
  onOpenWorkspace: () => void;
  onOpenAttendance: () => void;
  onLogout: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return undefined;
    const closeFromOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeFromEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('pointerdown', closeFromOutside);
    document.addEventListener('keydown', closeFromEscape);
    return () => {
      document.removeEventListener('pointerdown', closeFromOutside);
      document.removeEventListener('keydown', closeFromEscape);
    };
  }, [open]);

  const runAndClose = (action: () => void) => {
    setOpen(false);
    action();
  };

  return (
    <div className="admin-account-menu" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="admin-account-trigger"
        aria-label={`Mở menu tài khoản của ${user.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Tài khoản"
        onClick={() => setOpen((current) => !current)}
      >
        <Avatar src={user.avatar_url || user.face_ref_url} name={user.name} className="admin-avatar" textSize="" />
      </button>
      {open ? (
        <div className="admin-account-popover" role="menu">
          <header><Avatar src={user.avatar_url || user.face_ref_url} name={user.name} className="admin-avatar" textSize="" /><span><strong>{user.name}</strong><small>{user.email}</small></span></header>
          <button type="button" role="menuitem" onClick={() => runAndClose(onOpenWorkspace)}><span className="material-symbols-rounded" aria-hidden="true">apps</span><span><strong>Không gian làm việc</strong><small>Chọn lại khu vực truy cập</small></span></button>
          <button type="button" role="menuitem" onClick={() => runAndClose(onOpenAttendance)}><span className="material-symbols-rounded" aria-hidden="true">schedule</span><span><strong>Ứng dụng chấm công</strong><small>Quay lại trải nghiệm nhân viên</small></span></button>
          <div role="separator" />
          <button type="button" role="menuitem" className="danger" onClick={() => runAndClose(onLogout)}><span className="material-symbols-rounded" aria-hidden="true">logout</span><span><strong>Đăng xuất</strong><small>Kết thúc phiên trên thiết bị này</small></span></button>
        </div>
      ) : null}
    </div>
  );
}

export default function AdminApp({ user, onLogout }: { user: Employee; onLogout: () => void }) {
  const navigate = useNavigate();
  const capabilities = getAdminCapabilities(user.role);
  const navigation = useMemo(() => ADMIN_NAV.filter((item) => {
    if (item.id === 'accounts') return capabilities.manageAccounts;
    if (item.id === 'scheduling') return capabilities.manageSchedules;
    if (item.id === 'settings') return capabilities.manageSettings;
    if (item.id === 'audit') return capabilities.viewAudit;
    return true;
  }), [capabilities.manageAccounts, capabilities.manageSchedules, capabilities.manageSettings, capabilities.viewAudit]);
  const [section, setSection] = useState<AdminSection>('overview');
  const [data, setData] = useState<AdminData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [month, setMonth] = useState(() => toLocalMonthString());
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true);
    else setLoading(true);
    try {
      setData(await getAdminData(monthRange(month)));
      setLoadError(null);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Không tải được dữ liệu quản trị.';
      setLoadError(errorMessage);
      setMessage({ type: 'error', text: errorMessage });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [month]);

  useEffect(() => {
    void load();
  }, [load]);

  const run: AdminActionRunner = useCallback(async (task, successMessage, options) => {
    setBusy(true);
    setMessage(null);
    try {
      await task();
      setMessage({ type: 'success', text: successMessage });
      if (options?.refresh !== false) await load(true);
      return true;
    } catch (error) {
      setMessage({ type: 'error', text: error instanceof Error ? error.message : 'Không hoàn tất được thao tác.' });
      return false;
    } finally {
      setBusy(false);
    }
  }, [load]);

  const currentNav = navigation.find((item) => item.id === section) || navigation[0];
  const pendingCount = data?.requests.length || 0;
  const currentProfile = data?.employees.find((employee) => employee.employee_id === user.employee_id) || user;

  return (
    <main className="admin-shell">
      <aside className="app-nav-container admin-nav-container">
        <nav aria-label="Điều hướng quản trị" className="app-nav-shell admin-nav-shell">
          {navigation.map((item) => {
            const isActive = section === item.id;
            const itemPendingCount = item.id === 'attendance' ? pendingCount : 0;
            const accessibleLabel = itemPendingCount ? `${item.label}, ${itemPendingCount} mục cần xử lý` : item.label;

            return (
              <button
                type="button"
                className={`app-nav-item admin-nav-item ${isActive ? 'app-nav-item-selected' : ''}`}
                aria-label={accessibleLabel}
                aria-current={isActive ? 'page' : undefined}
                title={item.label}
                onClick={() => setSection(item.id)}
                key={item.id}
              >
                <span className="app-nav-icon">
                  {isActive ? (
                    <motion.span
                      aria-hidden="true"
                      layoutId="adminNavigationActiveTab"
                      className="app-nav-track"
                      transition={UI_MOTION.NAVIGATION_SPRING}
                    />
                  ) : null}
                  <span className="material-symbols-rounded" aria-hidden="true">{item.icon}</span>
                  {itemPendingCount ? <span className="app-nav-badge" aria-hidden="true">{itemPendingCount > 99 ? '99+' : itemPendingCount}</span> : null}
                </span>
                <span className="admin-nav-label" aria-hidden="true">{item.label}</span>
              </button>
            );
          })}
        </nav>
      </aside>
      <div className="admin-nav-fade" aria-hidden="true" />

      <section className="admin-workspace">
        <header className="admin-topbar">
          <div><span>{APP_INFO.PRODUCT_NAME}</span><h1>{currentNav?.label}</h1></div>
          <div className="admin-topbar-actions">
            {user.role !== 'Admin' ? <span className="admin-role-badge">Phạm vi {user.role}</span> : null}
            <button type="button" className="admin-icon-button" disabled={refreshing} onClick={() => void load(true)} aria-label="Tải lại dữ liệu"><span className={`material-symbols-rounded ${refreshing ? 'spinning' : ''}`}>refresh</span></button>
            <AdminAccountMenu user={currentProfile} onOpenWorkspace={() => navigate(APP_ROUTES.HOME)} onOpenAttendance={() => navigate(APP_ROUTES.ATTENDANCE)} onLogout={onLogout} />
          </div>
        </header>

        {message ? <div className={`admin-flash ${message.type}`} role={message.type === 'error' ? 'alert' : 'status'} aria-live={message.type === 'error' ? 'assertive' : 'polite'}><span className="material-symbols-rounded" aria-hidden="true">{message.type === 'success' ? 'check_circle' : 'error'}</span><span>{message.text}</span><button type="button" onClick={() => setMessage(null)} aria-label="Đóng thông báo"><span className="material-symbols-rounded" aria-hidden="true">close</span></button></div> : null}
        {loading && !data ? <div className="admin-loading" role="status" aria-live="polite"><span className="admin-spinner" aria-hidden="true" /><strong>Đang tải Control Center…</strong><small>Đồng bộ tài khoản, chính sách và bảng công</small></div> : null}

        {!loading && !data && loadError ? (
          <section className="admin-load-error" role="alert" aria-labelledby="admin-load-error-title">
            <span className="material-symbols-rounded" aria-hidden="true">cloud_off</span>
            <div>
              <strong id="admin-load-error-title">Chưa thể tải Control Center</strong>
              <p>{loadError}</p>
            </div>
            <button type="button" className="admin-primary-button" onClick={() => void load()}>
              <span className="material-symbols-rounded" aria-hidden="true">refresh</span>Thử lại
            </button>
          </section>
        ) : null}

        {data ? (
          <div className="admin-content">
            {section === 'overview' ? <OverviewSection data={data} today={todayInVietnam()} onNavigate={setSection} /> : null}
            {section === 'accounts' && capabilities.manageAccounts ? <AccountsSection data={data} currentEmployeeId={user.employee_id} busy={busy} onRun={run} /> : null}
            {section === 'scheduling' && capabilities.manageSchedules ? <SchedulingSection data={data} month={month} onMonthChange={setMonth} busy={busy} onRun={run} /> : null}
            {section === 'attendance' ? <AttendanceSection data={data} month={month} onMonthChange={setMonth} busy={busy} onRun={run} /> : null}
            {section === 'settings' && capabilities.manageSettings ? <SettingsSection data={data} busy={busy} onRun={run} /> : null}
            {section === 'kiosks' ? <KiosksSection data={data} busy={busy} canManage={capabilities.manageKiosks} onRun={run} onOpenStation={() => navigate(APP_ROUTES.KIOSK)} /> : null}
            {section === 'audit' && capabilities.viewAudit ? <AuditSection data={data} /> : null}
          </div>
        ) : null}
      </section>
    </main>
  );
}
