import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { AdminSelect } from './components/AdminCommon';

// Each section (and its own dependencies — e.g. OverviewSection pulls in recharts,
// AccountsSection/AttendanceSection pull in the Excel export code) only downloads
// once an admin actually opens that tab, instead of all loading up front.
const AccountsSection = lazy(() => import('./components/AccountsSection'));
const AttendanceSection = lazy(() => import('./components/AttendanceSection'));
const AuditSection = lazy(() => import('./components/AuditSection'));
const KiosksSection = lazy(() => import('./components/KiosksSection'));
const OverviewSection = lazy(() => import('./components/OverviewSection'));
const SettingsSection = lazy(() => import('./components/SettingsSection'));
const SchedulingSection = lazy(() => import('./components/SchedulingSection'));

function AdminSectionFallback() {
  return (
    <div className="admin-loading" role="status" aria-live="polite">
      <span className="admin-spinner" aria-hidden="true" />
      <strong>Đang tải…</strong>
    </div>
  );
}

function todayInVietnam() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

const UNASSIGNED_REGION = 'Chưa phân khu vực';

interface AdminScope {
  region: string;
  branch: string;
}

const EMPTY_SCOPE: AdminScope = { region: 'all', branch: 'all' };

// Narrows the operational, list-shaped slices of AdminData to a branch or region
// so a multi-branch org can be managed one area at a time. Config-shaped slices
// (locations, policies, shifts, holidays, settings, periods) stay complete so the
// editors keep working regardless of the active scope.
// `allowedBranchIds` is the hard ceiling for a Director/HR operator restricted to
// their managed locations; when set, the result is always intersected with it.
// NOTE: this is a UI restriction only — real enforcement lives in Postgres RLS.
function scopeAdminData(
  data: AdminData,
  scope: AdminScope,
  allowedBranchIds: Set<string> | null = null,
): { data: AdminData; scoped: boolean } {
  let branchIds: Set<string> | null = null;
  if (scope.branch !== 'all') {
    branchIds = new Set([scope.branch]);
  } else if (scope.region !== 'all') {
    branchIds = new Set(
      data.locations.filter((location) => (location.city?.trim() || UNASSIGNED_REGION) === scope.region).map((location) => location.center_id),
    );
  }
  if (allowedBranchIds) {
    branchIds = new Set(
      [...(branchIds ?? new Set(data.locations.map((location) => location.center_id)))].filter((id) => allowedBranchIds.has(id)),
    );
  }
  if (!branchIds) return { data, scoped: false };

  const inScope = branchIds;
  const employees = data.employees.filter((employee) => {
    if (inScope.has(employee.center_id)) return true;
    return [...(employee.allowed_locations || []), ...(employee.managed_locations || [])].some((id) => inScope.has(id));
  });
  const employeeIds = new Set(employees.map((employee) => employee.employee_id));
  const byEmployee = <T extends { employee_id?: string }>(rows: T[]) =>
    rows.filter((row) => (row.employee_id ? employeeIds.has(row.employee_id) : false));

  return {
    scoped: true,
    data: {
      ...data,
      employees,
      timesheets: byEmployee(data.timesheets),
      requests: byEmployee(data.requests),
      monthlyRequests: data.monthlyRequests ? byEmployee(data.monthlyRequests) : data.monthlyRequests,
      devices: byEmployee(data.devices),
      shiftAssignments: byEmployee(data.shiftAssignments),
      stations: data.stations.filter((station) => inScope.has(station.center_id)),
    },
  };
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
  const [data, setData] = useState<AdminData | null>(null);
  const capabilities = getAdminCapabilities(user.role, data?.capabilities);
  const navigation = useMemo(() => ADMIN_NAV.filter((item) => {
    if (item.id === 'accounts') return capabilities.manageAccounts;
    if (item.id === 'scheduling') return capabilities.manageSchedules;
    if (item.id === 'attendance') return capabilities.viewAttendance || capabilities.exportAttendance || capabilities.reviewAttendance || capabilities.lockAttendance;
    if (item.id === 'settings') return capabilities.manageSettings;
    if (item.id === 'kiosks') return capabilities.manageKiosks;
    if (item.id === 'audit') return capabilities.viewAudit;
    return true;
  }), [capabilities.exportAttendance, capabilities.lockAttendance, capabilities.manageAccounts, capabilities.manageKiosks, capabilities.manageSchedules, capabilities.manageSettings, capabilities.reviewAttendance, capabilities.viewAttendance, capabilities.viewAudit]);
  const allowedSections = useMemo<ReadonlySet<AdminSection>>(
    () => new Set(navigation.map((item) => item.id)),
    [navigation],
  );
  const [section, setSection] = useState<AdminSection>('overview');
  const [scope, setScope] = useState<AdminScope>(EMPTY_SCOPE);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [month, setMonth] = useState(() => toLocalMonthString());
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const loadRevisionRef = useRef(0);
  const monthRef = useRef(month);
  const loadedMonthRef = useRef<string | null>(null);
  monthRef.current = month;

  const load = useCallback(async (silent = false, targetMonth = monthRef.current) => {
    const loadRevision = loadRevisionRef.current + 1;
    loadRevisionRef.current = loadRevision;
    const changingMonth = loadedMonthRef.current !== targetMonth;
    if (changingMonth) {
      setData(null);
      setLoading(true);
      setRefreshing(false);
    } else if (silent) setRefreshing(true);
    else setLoading(true);
    try {
      const nextData = await getAdminData(monthRange(targetMonth));
      if (loadRevision !== loadRevisionRef.current) return;
      loadedMonthRef.current = targetMonth;
      setData(nextData);
      setLoadError(null);
    } catch (error) {
      if (loadRevision !== loadRevisionRef.current) return;
      const errorMessage = error instanceof Error ? error.message : 'Không tải được dữ liệu quản trị.';
      setLoadError(errorMessage);
      setMessage({ type: 'error', text: errorMessage });
    } finally {
      if (loadRevision === loadRevisionRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    void load(false, month);
  }, [load, month]);

  useEffect(() => {
    if (!navigation.some((item) => item.id === section)) setSection(navigation[0]?.id || 'overview');
  }, [navigation, section]);

  const handleMonthChange = useCallback((nextMonth: string) => {
    if (nextMonth === monthRef.current) return;
    monthRef.current = nextMonth;
    loadRevisionRef.current += 1;
    setData(null);
    setLoading(true);
    setRefreshing(false);
    setLoadError(null);
    setMonth(nextMonth);
  }, []);

  const run: AdminActionRunner = useCallback(async (task, successMessage, options) => {
    setBusy(true);
    setMessage(null);
    try {
      await task();
      setMessage({ type: 'success', text: successMessage });
      if (options?.refresh !== false) await load(true, monthRef.current);
      return true;
    } catch (error) {
      setMessage({ type: 'error', text: error instanceof Error ? error.message : 'Không hoàn tất được thao tác.' });
      // Multi-system operations (notably Auth + employee profile imports) may
      // have committed before a response was interrupted. Reload the tenant's
      // authoritative state before allowing the operator to retry.
      const shouldRefresh = typeof options?.refreshOnError === 'function'
        ? options.refreshOnError(error)
        : options?.refreshOnError;
      if (shouldRefresh) await load(true, monthRef.current);
      return false;
    } finally {
      setBusy(false);
    }
  }, [load]);

  const currentProfile = data?.employees.find((employee) => employee.employee_id === user.employee_id) || user;

  // Director / HR are pinned to the branches they manage; Admin sees the whole org.
  // The lock only takes effect once we know which branches exist in the loaded data.
  const lockedBranchIds = useMemo(() => {
    if (user.role === 'Admin') return null;
    const managed = (currentProfile.managed_locations || user.managed_locations || []).filter(Boolean);
    return managed.length ? new Set(managed) : null;
  }, [currentProfile.managed_locations, user.managed_locations, user.role]);

  const visibleLocations = useMemo(
    () => (data ? data.locations.filter((location) => !lockedBranchIds || lockedBranchIds.has(location.center_id)) : []),
    [data, lockedBranchIds],
  );

  const regionOptions = useMemo(
    () => [...new Set(visibleLocations.map((location) => location.city?.trim() || UNASSIGNED_REGION))].sort((a, b) => a.localeCompare(b, 'vi')),
    [visibleLocations],
  );

  const branchOptions = useMemo(
    () => visibleLocations
      .filter((location) => scope.region === 'all' || (location.city?.trim() || UNASSIGNED_REGION) === scope.region)
      .sort((a, b) => a.center_name.localeCompare(b.center_name, 'vi'))
      .map((location) => ({ value: location.center_id, label: location.center_name })),
    [visibleLocations, scope.region],
  );

  const { data: scopedData, scoped } = useMemo(
    () => (data ? scopeAdminData(data, scope, lockedBranchIds) : { data: null as AdminData | null, scoped: false }),
    [data, scope, lockedBranchIds],
  );

  const currentNav = navigation.find((item) => item.id === section) || navigation[0];
  const pendingCount = scopedData?.requests.length || 0;
  const showScope = Boolean(data && visibleLocations.length > 1);

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
          {showScope ? (
            <div className="admin-scope" role="group" aria-label="Phạm vi chi nhánh">
              <span className="material-symbols-rounded" aria-hidden="true">{lockedBranchIds ? 'lock' : 'travel_explore'}</span>
              {regionOptions.length > 1 ? (
                <AdminSelect
                  value={scope.region}
                  onChange={(value) => setScope({ region: value, branch: 'all' })}
                  label="Khu vực"
                  options={[{ value: 'all', label: lockedBranchIds ? 'Khu vực quản lý' : 'Mọi khu vực' }, ...regionOptions.map((region) => ({ value: region, label: region }))]}
                />
              ) : null}
              <AdminSelect
                value={scope.branch}
                onChange={(value) => setScope((current) => ({ ...current, branch: value }))}
                label="Chi nhánh"
                options={[
                  { value: 'all', label: lockedBranchIds ? 'Chi nhánh quản lý' : (scope.region === 'all' ? 'Mọi chi nhánh' : `Mọi chi nhánh · ${scope.region}`) },
                  ...branchOptions,
                ]}
              />
              {scoped && !lockedBranchIds ? (
                <button type="button" className="admin-text-button" onClick={() => setScope(EMPTY_SCOPE)}>Bỏ lọc</button>
              ) : null}
            </div>
          ) : null}
          <div className="admin-topbar-actions">
            {user.role !== 'Admin' ? <span className="admin-role-badge">Phạm vi {user.role}</span> : null}
            <button type="button" className="admin-icon-button" disabled={loading || refreshing} onClick={() => void load(true)} aria-label="Tải lại dữ liệu"><span className={`material-symbols-rounded ${refreshing ? 'spinning' : ''}`}>refresh</span></button>
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

        {data && scopedData ? (
          <div className="admin-content">
            {scoped ? (
              <p className="admin-scope-note" role="status">
                {lockedBranchIds ? 'Phân quyền theo chi nhánh · ' : 'Đang xem '}
                <strong>
                  {scope.branch !== 'all'
                    ? (branchOptions.find((b) => b.value === scope.branch)?.label || scope.branch)
                    : scope.region !== 'all'
                      ? scope.region
                      : lockedBranchIds
                        ? visibleLocations.map((location) => location.center_name).join(', ')
                        : 'Toàn tổ chức'}
                </strong>
                {' · '}{scopedData.employees.length} nhân sự
              </p>
            ) : null}
            <Suspense fallback={<AdminSectionFallback />}>
              {section === 'overview' ? <OverviewSection data={scopedData} today={todayInVietnam()} allowedSections={allowedSections} onNavigate={setSection} /> : null}
              {section === 'accounts' && capabilities.manageAccounts ? <AccountsSection data={scopedData} currentEmployeeId={user.employee_id} busy={busy} onRun={run} /> : null}
              {section === 'scheduling' && capabilities.manageSchedules ? <SchedulingSection data={scopedData} month={month} onMonthChange={handleMonthChange} busy={busy} onRun={run} /> : null}
              {section === 'attendance' ? <AttendanceSection data={scopedData} month={month} onMonthChange={handleMonthChange} busy={busy} canReview={capabilities.reviewAttendance} canExport={capabilities.exportAttendance} canLock={capabilities.lockAttendance} onRun={run} /> : null}
              {section === 'settings' && capabilities.manageSettings ? <SettingsSection data={scopedData} busy={busy} onRun={run} /> : null}
              {section === 'kiosks' ? <KiosksSection data={scopedData} busy={busy} canManage={capabilities.manageKiosks} onRun={run} onOpenStation={() => navigate(APP_ROUTES.KIOSK)} /> : null}
              {section === 'audit' && capabilities.viewAudit ? <AuditSection data={scopedData} /> : null}
            </Suspense>
          </div>
        ) : null}
      </section>
    </main>
  );
}
