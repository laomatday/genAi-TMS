import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { Employee, ExplainableAttendanceItem } from '@/shared/types';
import { doCheckOut } from '@/modules/tms/services/employee';
import { recordQrAttendance } from '@/modules/tms/services/attendance';
import { buildLocationNameMap } from '@/modules/tms/services/locations';
import { triggerHaptic, playAudioChime, toISODateString } from '@/core/utils/helpers';
import { useDashboardData } from '@/modules/tms/hooks/useDashboardData';
import { useNotificationInbox } from '@/modules/tms/hooks/useNotificationInbox';
import { assertValidAttendancePosition } from '@/modules/tms/utils/attendancePosition';
import { hasControlCenterAccess } from '@/modules/tms/services/workforceCapabilities';
import { useToast } from '@/shared/contexts/useToast';
import { motion, AnimatePresence } from 'framer-motion';
import TabHome from '@/modules/tms/pages/Home';
import BottomNav, { EMPLOYEE_NAV_TABS, isEmployeeNavTab, type EmployeeNavTab, type TabType } from './BottomNav';
import EmployeePager from './EmployeePager';
import Header from './Header';
import ConfirmDialog from '@/shared/components/modals/ConfirmDialog';
import Spinner from '@/shared/components/common/Spinner';
import LoadingScreen from '@/shared/components/common/LoadingScreen';
import { canApproveAny, TMS_LIMITS, UI_MOTION } from '@/shared/constants';
import { useAuth } from '@/core/auth/useAuth';
import { createAttendanceWatchdog, type AttendanceWatchdog } from '@/modules/tms/services/attendanceWatchdog';
import {
  ATTENDANCE_ACTIVITY_EVENT,
  DASHBOARD_SYNC_STATE_EVENT,
  type DashboardSyncStateDetail,
} from '@/shared/components/common/AppStatusBanner';
import {
  employeeSearchForModal,
  employeeSearchForTab,
  employeeSearchWithoutModal,
  parseEmployeeNavigation,
  type EmployeeModalLayer,
} from '@/modules/tms/navigation/employeeNavigation';

const TabHistory = lazy(() => import('@/modules/tms/pages/History'));
const TabRequests = lazy(() => import('@/modules/tms/pages/Requests'));
const TabContacts = lazy(() => import('@/modules/tms/pages/Contacts'));
const TabProfile = lazy(() => import('@/modules/tms/pages/Profile'));
const TabManager = lazy(() => import('@/modules/tms/pages/Manager'));
const CalendarPage = lazy(() => import('@/modules/tms/pages/Calendar'));
const ModalQRScanner = lazy(() => import('./ModalQRScanner'));
const NotificationsModal = lazy(() => import('./NotificationsModal'));
const ModalCreateRequest = lazy(() => import('./ModalCreateRequest'));
const ModalExplainWork = lazy(() => import('./ModalExplainWork'));

interface Props { user: Employee; onLogout: () => void; onOpenWorkspace?: () => void; }

interface EmployeeHistoryState {
  tmsLayer?: 'tab' | 'modal';
  tmsDepth?: number;
}

function requestCurrentPosition() {
  return new Promise<GeolocationPosition>((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new Error('Thiết bị không hỗ trợ định vị.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: TMS_LIMITS.GPS_TIMEOUT_MS,
      maximumAge: 0,
    });
  });
}

function attendanceErrorMessage(error: unknown) {
  if (error && typeof error === 'object' && 'code' in error && typeof (error as { code?: unknown }).code === 'number') {
    const geolocationError = error as GeolocationPositionError;
    if (geolocationError.code === geolocationError.PERMISSION_DENIED) return 'Bạn cần cho phép truy cập vị trí để chấm công.';
    if (geolocationError.code === geolocationError.TIMEOUT) return 'Không lấy được vị trí đủ nhanh. Hãy ra nơi thoáng và thử lại.';
    return 'Không xác định được vị trí hiện tại. Vui lòng bật GPS và thử lại.';
  }
  return error instanceof Error ? error.message : 'Không thể hoàn tất chấm công.';
}

function receiptTime(value?: string) {
  if (!value) return new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', hour12: false });
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

const AppShell: React.FC<Props> = ({ user, onLogout, onOpenWorkspace }) => {
  const location = useLocation();
  const navigate = useNavigate();
  const { updateProfile } = useAuth();
  const { showToast } = useToast();
  const handleShowAlert = useCallback((title: string, msg: string, type: 'success' | 'error' | 'warning' | 'info' = 'success') => {
    triggerHaptic(type === 'success' ? 'success' : type === 'warning' ? 'warning' : 'error');
    if (type === 'success') playAudioChime('success');
    else if (type === 'error' || type === 'warning') playAudioChime('error');
    showToast({ title, body: msg, type });
  }, [showToast]);
  const { data, loading, error, currentUser, isOnline, lastSyncedAt, refresh } = useDashboardData(user, onLogout);
  const {
    items: inboxItems,
    unreadCount: inboxUnreadCount,
    loading: inboxLoading,
    refresh: refreshInbox,
    markRead: markInboxRead,
    markAllRead: markAllInboxRead,
  } = useNotificationInbox(currentUser);
  const navigationState = useMemo(() => parseEmployeeNavigation(location.search), [location.search]);
  const activeTab = navigationState.tab;
  const activeModal = navigationState.modal;
  const [pagerNavigationResetVersion, setPagerNavigationResetVersion] = useState(0);
  const [direction, setDirection] = useState<'left' | 'right'>('right');
  const [lastActiveTab, setLastActiveTab] = useState<TabType>('home');
  const [lastEmployeeTab, setLastEmployeeTab] = useState<EmployeeNavTab>('home');
  const [isHeaderVisible, setIsHeaderVisible] = useState(true);
  const [isAttendanceProcessing, setIsAttendanceProcessing] = useState(false);
  const [isProcessOverlayVisible, setIsProcessOverlayVisible] = useState(false);
  const [checkInStatus, setCheckInStatus] = useState('');
  const [createRequestType, setCreateRequestType] = useState<string | undefined>(undefined);
  const [explainWorkInitialData, setExplainWorkInitialData] = useState<{ date: string; reason: string } | null>(null);
  const [contactsResetTrigger, setContactsResetTrigger] = useState(0);
  const [contactsSearchTrigger, setContactsSearchTrigger] = useState(0);
  const managerDate = new Date();
  const attendanceLockRef = useRef(false);
  const watchdogRef = useRef<AttendanceWatchdog | null>(null);
  const previousTabRef = useRef<TabType>(activeTab);
  const historyState = location.state as EmployeeHistoryState | null;
  const showQRScanner = activeModal === 'qr';
  const showCheckoutConfirm = activeModal === 'checkout';
  const showCreateRequestModal = activeModal === 'request';
  const showExplainWorkModal = activeModal === 'explanation' || activeModal === 'explanation-confirm';
  const showExplanationConfirm = activeModal === 'explanation-confirm';
  const showImageCropper = activeModal === 'profile-crop';
  const isSettingsOpen = activeModal === 'settings' || activeModal === 'settings-guide' || activeModal === 'settings-support';

  const navigateToSearch = useCallback((search: string, options?: { replace?: boolean; state?: EmployeeHistoryState | null }) => {
    navigate({ pathname: location.pathname, search }, options);
  }, [location.pathname, navigate]);

  const openModal = useCallback((modal: EmployeeModalLayer, options?: { requestType?: string; explanationDate?: string }) => {
    navigateToSearch(employeeSearchForModal(location.search, modal, options), {
      state: { tmsLayer: 'modal', tmsDepth: Math.max(0, historyState?.tmsDepth ?? 0) + 1 },
    });
  }, [historyState?.tmsDepth, location.search, navigateToSearch]);

  const closeModal = useCallback(() => {
    if (!activeModal) return;
    if (historyState?.tmsLayer === 'modal') {
      navigate(-1);
      return;
    }
    navigateToSearch(employeeSearchWithoutModal(location.search), { replace: true, state: null });
  }, [activeModal, historyState?.tmsLayer, location.search, navigate, navigateToSearch]);

  const setSettingsOpen = useCallback((open: boolean) => {
    if (open) openModal('settings');
    else if (activeModal === 'settings') closeModal();
  }, [activeModal, closeModal, openModal]);

  const closeModalStack = useCallback(() => {
    const depth = historyState?.tmsDepth ?? 0;
    if (depth > 0) {
      navigate(-depth);
      return;
    }
    navigateToSearch(employeeSearchWithoutModal(location.search), { replace: true, state: null });
  }, [historyState?.tmsDepth, location.search, navigate, navigateToSearch]);
  const refreshDashboardAndInbox = useCallback(async () => {
    const [dashboardUpdated, notificationsUpdated] = await Promise.all([refresh(), refreshInbox()]);
    return dashboardUpdated || notificationsUpdated;
  }, [refresh, refreshInbox]);

  useEffect(() => {
    const detail: DashboardSyncStateDetail = {
      error: data && isOnline ? error || null : null,
      lastSyncedAt: lastSyncedAt?.toISOString() || null,
      retry: () => { void refresh(); },
    };
    window.dispatchEvent(new CustomEvent(DASHBOARD_SYNC_STATE_EVENT, { detail }));
  }, [data, error, isOnline, lastSyncedAt, refresh]);

  useEffect(() => () => {
    const detail: DashboardSyncStateDetail = { error: null, lastSyncedAt: null };
    window.dispatchEvent(new CustomEvent(DASHBOARD_SYNC_STATE_EVENT, { detail }));
  }, []);

  const canManage = useMemo(
    () => Boolean(
      currentUser?.role
      && data?.capabilities.includes('team.read')
      && data?.capabilities.includes('attendance.review')
      && canApproveAny(currentUser.role, data.approvalRoles),
    ),
    [currentUser, data?.approvalRoles, data?.capabilities],
  );
  const canOpenControlCenter = Boolean(
    onOpenWorkspace
    && data
    && hasControlCenterAccess(data.capabilities),
  );

  useEffect(() => {
    if (!canManage && activeTab === 'manager') {
      navigateToSearch(employeeSearchForTab(location.search, lastEmployeeTab), { replace: true, state: null });
    }
  }, [activeTab, canManage, lastEmployeeTab, location.search, navigateToSearch]);
  const locationNames = useMemo(() => buildLocationNameMap(data), [data]);

  // On-time ratio across every shift in the loaded timesheet window. Shown on the
  // profile; null while nothing has been recorded so the tile can say so.
  const punctuality = useMemo(() => {
    const worked = (data?.history.history ?? []).filter((row) => Boolean(row.time_in));
    if (worked.length === 0) return null;
    const onTime = worked.filter((row) => Number(row.late_minutes || 0) <= 0).length;
    return { rate: (onTime / worked.length) * 100, sample: worked.length };
  }, [data?.history.history]);

  useEffect(() => {
    const watchdog = createAttendanceWatchdog(TMS_LIMITS.ATTENDANCE_WATCHDOG_MS, () => {
      attendanceLockRef.current = false;
      setIsAttendanceProcessing(false);
      setIsProcessOverlayVisible(false);
      setCheckInStatus('');
      // Deliberately not "failed": the command may well have been recorded.
      // Every attendance command carries a durable id, so trying again is
      // treated as the same command rather than a second punch.
      handleShowAlert(
        'Chưa nhận được xác nhận',
        'Máy chủ chưa phản hồi nên chưa rõ lần chấm công vừa rồi đã ghi nhận hay chưa. Hãy mở Lịch sử để kiểm tra; nếu chưa có, chấm lại bình thường.',
        'warning',
      );
    });
    watchdogRef.current = watchdog;

    // A phone that suspends the page suspends this countdown with it, so the
    // moment the app is on screen again is when the overdue lock gets caught.
    const checkOnResume = () => {
      if (document.visibilityState === 'visible') watchdog.expireIfOverdue();
    };
    document.addEventListener('visibilitychange', checkOnResume);
    window.addEventListener('focus', checkOnResume);
    return () => {
      document.removeEventListener('visibilitychange', checkOnResume);
      window.removeEventListener('focus', checkOnResume);
      watchdog.disarm();
      watchdogRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const active = isAttendanceProcessing || showQRScanner || showCheckoutConfirm;
    window.dispatchEvent(new CustomEvent(ATTENDANCE_ACTIVITY_EVENT, { detail: { active } }));
    return () => {
      if (active) window.dispatchEvent(new CustomEvent(ATTENDANCE_ACTIVITY_EVENT, { detail: { active: false } }));
    };
  }, [isAttendanceProcessing, showCheckoutConfirm, showQRScanner]);

  useEffect(() => {
    // Warm the QR scanner chunk during idle time so tapping "Quét QR chấm công" doesn't
    // stall on the first download — cheap now that it no longer bundles a large decoder.
    let cancelled = false;
    const warm = () => { if (!cancelled) void import('./ModalQRScanner'); };
    const requestIdle = window.requestIdleCallback;
    let idleHandle: number | undefined;
    let timeoutHandle: number | undefined;
    if (typeof requestIdle === 'function') idleHandle = requestIdle(warm);
    else timeoutHandle = window.setTimeout(warm, 2000);
    return () => {
      cancelled = true;
      if (idleHandle !== undefined) window.cancelIdleCallback?.(idleHandle);
      if (timeoutHandle !== undefined) window.clearTimeout(timeoutHandle);
    };
  }, []);

  useEffect(() => {
    const previousTab = previousTabRef.current;
    if (previousTab === activeTab) return;
    const activeIndex = EMPLOYEE_NAV_TABS.findIndex((item) => item === previousTab);
    const fallbackIndex = EMPLOYEE_NAV_TABS.findIndex((item) => item === lastActiveTab);
    const targetIndex = EMPLOYEE_NAV_TABS.findIndex((item) => item === activeTab);
    const sourceIndex = activeIndex >= 0 ? activeIndex : fallbackIndex;
    setDirection(targetIndex >= 0 && targetIndex > sourceIndex ? 'right' : 'left');
    if (previousTab !== 'profile' && previousTab !== 'notifications') setLastActiveTab(previousTab);
    if (isEmployeeNavTab(previousTab)) setLastEmployeeTab(previousTab);
    if (previousTab === 'contacts') setContactsSearchTrigger(0);
    setIsHeaderVisible(true);
    previousTabRef.current = activeTab;
  }, [activeTab, lastActiveTab]);

  const handleTabChange = useCallback((tab: TabType) => {
    triggerHaptic('light');
    if (activeTab === tab && tab === 'contacts') { setContactsResetTrigger((value) => value + 1); return; }
    if (activeTab !== tab || activeModal) {
      navigateToSearch(employeeSearchForTab(location.search, tab), {
        replace: Boolean(activeModal),
        state: { tmsLayer: 'tab' },
      });
    }
    if (tab === 'notifications') {
      void refreshInbox();
    }
  }, [activeModal, activeTab, location.search, navigateToSearch, refreshInbox]);

  const closeSecondaryTab = useCallback(() => {
    if (historyState?.tmsLayer === 'tab') {
      navigate(-1);
      return;
    }
    navigateToSearch(employeeSearchForTab(location.search, lastActiveTab), { replace: true, state: null });
  }, [historyState?.tmsLayer, lastActiveTab, location.search, navigate, navigateToSearch]);

  const handleBottomNavChange = (tab: TabType) => {
    // This revision also changes for a repeated tap on the active tab. The
    // pager uses it to invalidate any delayed touch/transition callback.
    setPagerNavigationResetVersion((version) => version + 1);
    handleTabChange(tab);
  };

  const beginAttendanceTransaction = (status: string) => {
    if (attendanceLockRef.current) {
      setIsProcessOverlayVisible(true);
      handleShowAlert('Đang xử lý', 'Yêu cầu chấm công trước đó vẫn đang được xử lý.', 'warning');
      return false;
    }
    if (!navigator.onLine || !isOnline) {
      handleShowAlert('Không có kết nối', 'Chấm công cần kết nối mạng để nhận xác nhận từ hệ thống.', 'error');
      return false;
    }
    attendanceLockRef.current = true;
    watchdogRef.current?.arm();
    setIsAttendanceProcessing(true);
    setIsProcessOverlayVisible(true);
    setCheckInStatus(status);
    return true;
  };

  const finishAttendanceTransaction = () => {
    watchdogRef.current?.disarm();
    attendanceLockRef.current = false;
    setIsAttendanceProcessing(false);
    setIsProcessOverlayVisible(false);
  };

  const validateAttendancePosition = (position: GeolocationPosition) => {
    assertValidAttendancePosition({
      lat: position.coords.latitude,
      lng: position.coords.longitude,
      accuracy: position.coords.accuracy,
    });
    // Accuracy thresholds, geofence and assigned-location decisions are
    // authoritative on the server because every tenant can configure a
    // different attendance policy. The client only rejects malformed sensor data.
  };

  const handleQRScan = async (qrString: string) => {
    closeModal();
    if (!beginAttendanceTransaction('Đang kiểm tra GPS và kết nối…')) return;
    try {
      const position = await requestCurrentPosition();
      validateAttendancePosition(position);
      if (!navigator.onLine) throw new Error('Kết nối đã bị gián đoạn. Chưa có dữ liệu chấm công nào được gửi.');

      setCheckInStatus(`GPS ±${Math.round(position.coords.accuracy)}m · Đang xác thực QR, thiết bị và ca làm…`);
      const result = await recordQrAttendance({
        qrPayload: qrString,
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        accuracy: position.coords.accuracy,
      });
      await refresh();
      const recordedAt = receiptTime(result.receipt.occurred_at);
      const recordedLocation = result.receipt.location_name || currentUser.center_id;
      handleShowAlert('Check-in thành công', `${recordedAt} · ${recordedLocation}. ${result.message}`, 'success');
    } catch (caughtError) {
      handleShowAlert('Chấm công thất bại', attendanceErrorMessage(caughtError), 'error');
    } finally {
      finishAttendanceTransaction();
    }
  };

  const processCheckOut = async () => {
    triggerHaptic('medium');
    closeModal();
    if (!beginAttendanceTransaction('Đang kiểm tra GPS và kết nối…')) return;
    try {
      const position = await requestCurrentPosition();
      validateAttendancePosition(position);
      if (!navigator.onLine) throw new Error('Kết nối đã bị gián đoạn. Check-out chưa được gửi.');

      setCheckInStatus(`GPS ±${Math.round(position.coords.accuracy)}m · Đang xác thực ca đang mở…`);
      const result = await doCheckOut({
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        accuracy: position.coords.accuracy,
      });
      if (!result.success) throw new Error(result.message);
      await refresh();
      const recordedAt = receiptTime(result.receipt?.occurred_at);
      const recordedLocation = result.receipt?.location_name || currentUser.center_id;
      handleShowAlert('Check-out thành công', `${recordedAt} · ${recordedLocation}. ${result.message}`, 'success');
    } catch (caughtError) {
      handleShowAlert('Check-out thất bại', attendanceErrorMessage(caughtError), 'error');
    } finally {
      finishAttendanceTransaction();
    }
  };

  const explainableItems = useMemo(() => {
    if (!data) return [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayString = toISODateString(today);
    const list: ExplainableAttendanceItem[] = [];
    const loop = new Date();
    loop.setDate(loop.getDate() - TMS_LIMITS.EXPLANATION_LOOKBACK_DAYS);
    const holidays = Array.isArray(data.holidays) ? data.holidays : [];
    const isHoliday = (date: string) => holidays.some((holiday) => holiday.active !== false && date >= holiday.from_date && date <= holiday.to_date);

    while (loop <= today) {
      const dateString = toISODateString(loop);
      const rows = data.history.history.filter((row) => row.date === dateString);
      const reasons: string[] = [];
      let missingCheckin = false;
      let missingCheckout = false;
      if (rows.length) {
        const hasActualCheckin = rows.some((row) => Boolean(row.time_in));
        missingCheckout = hasActualCheckin && rows.some((row) => !row.time_out) && dateString !== todayString;
        missingCheckin = !hasActualCheckin
          && dateString !== todayString
          && rows.some((row) => row.status === 'Invalid' || row.note.includes('MISSING_CHECKIN'));
        if (missingCheckin) {
          missingCheckout = true;
          reasons.push('Thiếu Check-in và Check-out');
        } else if (missingCheckout) {
          reasons.push('Quên Check-out');
        }
        const late = rows.reduce((sum, row) => sum + Number(row.late_minutes || 0), 0);
        if (late) reasons.push(`Trễ ${late} phút`);
        const early = rows.reduce((sum, row) => sum + Number(row.early_minutes || 0), 0);
        if (early) reasons.push(`Về sớm ${early} phút`);
      } else {
        const offDays = Array.isArray(data.systemConfig?.OFF_DAYS) ? data.systemConfig.OFF_DAYS : [0, 6];
        if (dateString !== todayString && !offDays.includes(loop.getDay()) && !isHoliday(dateString)) {
          missingCheckin = true;
          missingCheckout = true;
          reasons.push('Không có dữ liệu chấm công');
        }
      }
      const explained = data.myExplanations.some((request) => request.date === dateString && request.status !== 'Rejected');
      const requested = data.myRequests.some((request) => dateString >= request.from_date && dateString <= request.to_date && request.status === 'Approved');
      if (reasons.length && !explained && !requested) {
        list.push({
          date: dateString,
          explainReason: reasons.join(', '),
          missingCheckin,
          missingCheckout,
          recordedCheckin: rows.find((row) => Boolean(row.time_in))?.time_in,
          recordedCheckout: rows.find((row) => Boolean(row.time_out))?.time_out,
        });
      }
      loop.setDate(loop.getDate() + 1);
    }

    const lockDate = data.systemConfig?.LOCK_DATE ?? TMS_LIMITS.LOCK_DATE;
    const year = today.getFullYear();
    const month = today.getMonth();
    const start = today.getDate() <= lockDate ? new Date(year, month - 1, 1) : new Date(year, month, 1);
    const end = new Date(year, month + 1, lockDate);
    end.setHours(23, 59, 59, 999);
    return list.filter((item) => {
      const date = new Date(`${item.date}T00:00:00`);
      return date >= start && date <= end;
    });
  }, [data]);

  const openQrScanner = () => {
    if (attendanceLockRef.current) { setIsProcessOverlayVisible(true); return; }
    if (!navigator.onLine || !isOnline) {
      handleShowAlert('Không có kết nối', 'Hãy kết nối mạng trước khi quét mã chấm công.', 'error');
      return;
    }
    openModal('qr');
  };

  const openCheckoutConfirm = () => {
    if (attendanceLockRef.current) { setIsProcessOverlayVisible(true); return; }
    if (!navigator.onLine || !isOnline) {
      handleShowAlert('Không có kết nối', 'Check-out cần kết nối mạng để nhận xác nhận từ hệ thống.', 'error');
      return;
    }
    openModal('checkout');
  };

  const openRequestModal = useCallback((type?: string) => {
    setCreateRequestType(type);
    openModal('request', { requestType: type });
  }, [openModal]);

  const openExplanationModal = useCallback((date?: string, reason = '') => {
    setExplainWorkInitialData(date ? { date, reason } : null);
    openModal('explanation', { explanationDate: date });
  }, [openModal]);

  if (loading) return <LoadingScreen />;
  if (!data) return <div className="h-full w-full page-bg flex items-center justify-center p-6"><div className="empty-state-card"><span className="material-symbols-rounded empty-state-icon" aria-hidden="true">cloud_off</span><h2>Không tải được dữ liệu</h2><p>{error || 'Vui lòng kiểm tra kết nối rồi thử lại.'}</p><button type="button" className="btn btn-primary btn-md" onClick={() => void refresh(true)}>Thử lại</button></div></div>;

  const activeEmployeeTab = isEmployeeNavTab(activeTab) ? activeTab : null;
  const pagerTab = activeEmployeeTab ?? lastEmployeeTab;
  const renderEmployeePage = (tab: EmployeeNavTab, isActive: boolean) => {
    switch (tab) {
      case 'home':
        return <TabHome data={data} loading={loading} onCheckOut={openCheckoutConfirm} onScanKiosk={openQrScanner} onRefresh={refresh} onExplain={openExplanationModal} explainableItems={explainableItems} onNavigate={handleTabChange} onCreateRequest={openRequestModal} />;
      case 'history':
        return <TabHistory isActive={isActive} data={data} onRefresh={refresh} onAlert={handleShowAlert} onExplain={openExplanationModal} />;
      case 'requests':
        return <TabRequests isActive={isActive} data={data} user={currentUser} onRefresh={refresh} onCreateRequest={openRequestModal} onCreateExplanation={() => openExplanationModal()} />;
      case 'calendar':
        return <CalendarPage isActive={isActive} data={data} user={currentUser} onRefresh={refresh} currentDate={managerDate} />;
      case 'contacts':
        return <TabContacts isActive={isActive} data={data} resetTrigger={isActive ? contactsResetTrigger : 0} searchTrigger={isActive ? contactsSearchTrigger : 0} setIsHeaderVisible={isActive ? setIsHeaderVisible : undefined} onNavigate={handleTabChange} />;
    }
  };

  return <div className="employee-shell" aria-busy={isAttendanceProcessing}>
    {isAttendanceProcessing && isProcessOverlayVisible ? <div className="app-process-backdrop animate-fade-in"><div className="app-process-dialog animate-scale-in" role="status" aria-live="polite"><Spinner size="lg" /><h3>Đang xử lý…</h3><p>{checkInStatus || 'Vui lòng đợi trong giây lát'}</p><small>Không đóng ứng dụng cho đến khi có xác nhận.</small><button type="button" onClick={() => setIsProcessOverlayVisible(false)}>Ẩn đi · vẫn chạy nền</button></div></div> : null}
    {isAttendanceProcessing && !isProcessOverlayVisible ? <button type="button" onClick={() => setIsProcessOverlayVisible(true)} className="app-processing-pill" aria-label="Mở trạng thái chấm công"><span className="app-processing-spinner" aria-hidden="true" />Đang chấm công</button> : null}
    {activeTab !== 'profile' && isHeaderVisible && <Header user={currentUser} activeTab={activeTab} notificationCount={inboxUnreadCount} isOnline={isOnline} locationName={locationNames[currentUser.center_id]} isSettingsOpen={isSettingsOpen} settingsLayer={activeModal} onSettingsOpenChange={setSettingsOpen} onOpenSettingsLayer={openModal} onCloseSettingsLayer={closeModal} onOpenProfile={() => handleTabChange('profile')} onOpenNotifications={() => activeTab === 'notifications' ? closeSecondaryTab() : handleTabChange('notifications')} onContactSearch={() => setContactsSearchTrigger((value) => value + 1)} canManage={canManage} onOpenManager={() => handleTabChange('manager')} onOpenWorkspace={canOpenControlCenter ? onOpenWorkspace : undefined} />}
    <div className="employee-scroll">
      <div className="employee-pager-layer" aria-hidden={!activeEmployeeTab} inert={!activeEmployeeTab}>
        <Suspense fallback={<div className="app-loading-screen"><Spinner size="lg" /></div>}>
          <EmployeePager activeTab={pagerTab} disabled={!activeEmployeeTab || Boolean(activeModal) || isAttendanceProcessing} navigationResetVersion={pagerNavigationResetVersion} onChange={handleTabChange} renderPage={renderEmployeePage} />
        </Suspense>
      </div>
      {!activeEmployeeTab ? <div className={`employee-motion-stage ${activeTab === 'profile' ? '' : 'employee-secondary-stage'}`.trim()}><AnimatePresence initial={false} custom={direction}><motion.div key={activeTab} custom={direction} initial={{ x: direction === 'right' ? UI_MOTION.PAGE_OFFSET_FORWARD : UI_MOTION.PAGE_OFFSET_BACKWARD }} animate={{ x: 0 }} exit={{ x: direction === 'right' ? UI_MOTION.PAGE_OFFSET_BACKWARD : UI_MOTION.PAGE_OFFSET_FORWARD }} transition={UI_MOTION.PAGE_TRANSITION} className="employee-view"><Suspense fallback={<div className="app-loading-screen"><Spinner size="lg" /></div>}>
        {activeTab === 'manager' && <TabManager data={data} user={currentUser} onRefresh={refresh} onAlert={handleShowAlert} />}
        {activeTab === 'profile' && <TabProfile user={currentUser} locations={data.locations || []} locationNames={locationNames} contacts={data.contacts || []} punctuality={punctuality} onLogout={onLogout} onUpdate={(profile) => { updateProfile(profile); void refresh(); }} onClose={closeSecondaryTab} onAlert={handleShowAlert} activeModal={activeModal} onOpenModal={openModal} onCloseModal={closeModal} onOpenManager={canManage ? () => handleTabChange('manager') : undefined} />}
        {activeTab === 'notifications' && <NotificationsModal notifications={inboxItems} unreadCount={inboxUnreadCount} loading={inboxLoading} onSwitchTab={handleTabChange} onMarkRead={markInboxRead} onMarkAllRead={markAllInboxRead} onRefresh={refreshDashboardAndInbox} />}
      </Suspense></motion.div></AnimatePresence></div> : null}
    </div>
    <Suspense fallback={null}>{showCreateRequestModal && <ModalCreateRequest user={currentUser} isOpen initialType={navigationState.requestType || createRequestType} onClose={closeModal} onSuccess={refresh} onAlert={handleShowAlert} onNavigate={handleTabChange} data={data} />} {showExplainWorkModal && <ModalExplainWork user={currentUser} isOpen isConfirmOpen={showExplanationConfirm} onConfirmOpenChange={(open) => open ? openModal('explanation-confirm', { explanationDate: navigationState.explanationDate || explainWorkInitialData?.date }) : closeModal()} onClose={closeModal} onComplete={closeModalStack} onSuccess={refresh} onAlert={handleShowAlert} initialData={explainWorkInitialData || (navigationState.explanationDate ? { date: navigationState.explanationDate, reason: '' } : undefined)} explainableItems={explainableItems} sourceTab={activeTab === 'requests' ? 'requests' : 'history'} onNavigate={handleTabChange} data={data} />}</Suspense>
    {activeTab !== 'profile' && !showCheckoutConfirm && !showImageCropper && <><div className="employee-nav-fade" /><BottomNav activeTab={activeTab} onChange={handleBottomNavChange} /></>}
    <Suspense fallback={null}>{showQRScanner && <ModalQRScanner onClose={closeModal} onScan={handleQRScan} onError={(message) => handleShowAlert('Lỗi thiết bị', message, 'error')} />}</Suspense>
    <ConfirmDialog isOpen={showCheckoutConfirm} title="Kết thúc ca làm việc?" message="Hệ thống sẽ ghi nhận giờ ra (Check-out)." confirmLabel="Xác nhận" onConfirm={processCheckOut} onCancel={closeModal} type="danger" />
  </div>;
};

export default AppShell;
