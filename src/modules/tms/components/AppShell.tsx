import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Employee, ExplainableAttendanceItem } from '@/shared/types';
import { doCheckOut } from '@/modules/tms/services/employee';
import { recordQrAttendance } from '@/modules/tms/services/attendance';
import { buildLocationNameMap } from '@/modules/tms/services/locations';
import { triggerHaptic, playAudioChime, toISODateString } from '@/core/utils/helpers';
import { useDashboardData } from '@/modules/tms/hooks/useDashboardData';
import { useToast } from '@/shared/contexts/useToast';
import { motion, AnimatePresence } from 'framer-motion';
import TabHome from '@/modules/tms/pages/Home';
import BottomNav, { EMPLOYEE_NAV_TABS, type TabType } from './BottomNav';
import Header from './Header';
import ConfirmDialog from '@/shared/components/modals/ConfirmDialog';
import Spinner from '@/shared/components/common/Spinner';
import LoadingScreen from '@/shared/components/common/LoadingScreen';
import { canApproveAny, scopedStorageKey, STORAGE_KEYS, TMS_LIMITS, UI_MOTION } from '@/shared/constants';
import { useAuth } from '@/core/auth/useAuth';
import { ATTENDANCE_ACTIVITY_EVENT } from '@/shared/components/common/AppStatusBanner';

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
  const { updateProfile } = useAuth();
  const { showToast } = useToast();
  const handleShowAlert = useCallback((title: string, msg: string, type: 'success' | 'error' | 'warning' | 'info' = 'success') => {
    triggerHaptic(type === 'success' ? 'success' : type === 'warning' ? 'warning' : 'error');
    if (type === 'success') playAudioChime('success');
    else if (type === 'error' || type === 'warning') playAudioChime('error');
    showToast({ title, body: msg, type });
  }, [showToast]);
  const notifyShiftEnd = useCallback((title: string, body: string) => handleShowAlert(title, body, 'warning'), [handleShowAlert]);
  const { data, loading, error, currentUser, isOnline, refresh } = useDashboardData(user, onLogout, notifyShiftEnd);
  const [activeTab, setActiveTab] = useState<TabType>('home');
  const [direction, setDirection] = useState<'left' | 'right'>('right');
  const [lastActiveTab, setLastActiveTab] = useState<TabType>('home');
  const [isHeaderVisible, setIsHeaderVisible] = useState(true);
  const [showQRScanner, setShowQRScanner] = useState(false);
  const [isAttendanceProcessing, setIsAttendanceProcessing] = useState(false);
  const [isProcessOverlayVisible, setIsProcessOverlayVisible] = useState(false);
  const [checkInStatus, setCheckInStatus] = useState('');
  const [showCheckoutConfirm, setShowCheckoutConfirm] = useState(false);
  const [showImageCropper, setShowImageCropper] = useState(false);
  const [showCreateRequestModal, setShowCreateRequestModal] = useState(false);
  const [createRequestType, setCreateRequestType] = useState<string | undefined>(undefined);
  const [showExplainWorkModal, setShowExplainWorkModal] = useState(false);
  const [explainWorkInitialData, setExplainWorkInitialData] = useState<{ date: string; reason: string } | null>(null);
  const [contactsResetTrigger, setContactsResetTrigger] = useState(0);
  const [contactsSearchTrigger, setContactsSearchTrigger] = useState(0);
  const notificationStorageKey = useMemo(
    () => scopedStorageKey(STORAGE_KEYS.SEEN_NOTIFICATIONS, user),
    [user.employee_id, user.organization_id],
  );
  const [seenNotiCount, setSeenNotiCount] = useState(() => {
    try { return parseInt(localStorage.getItem(notificationStorageKey) || '0', 10); } catch { return 0; }
  });
  const managerDate = new Date();
  const attendanceLockRef = useRef(false);

  useEffect(() => {
    try { setSeenNotiCount(parseInt(localStorage.getItem(notificationStorageKey) || '0', 10)); }
    catch { setSeenNotiCount(0); }
  }, [notificationStorageKey]);

  const canManage = useMemo(
    () => Boolean(currentUser?.role && canApproveAny(currentUser.role, data?.approvalRoles)),
    [currentUser, data?.approvalRoles],
  );
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

  const { rawNotiCount, badgeCount } = useMemo(() => {
    if (!data) return { rawNotiCount: 0, badgeCount: 0 };
    // Workforce V3 already returns reviewer requests scoped by capability and tenant.
    // Do not re-create authorization in the browser from contact metadata.
    const visibleApprovals = canManage
      ? data.notifications.approvals.length + data.notifications.explanationApprovals.length
      : 0;
    const personal = data.notifications.myRequests.filter((request) => request.status !== 'Pending').length
      + data.notifications.myExplanations.filter((request) => request.status !== 'Pending').length;
    const rawCount = visibleApprovals + personal;
    return { rawNotiCount: rawCount, badgeCount: Math.max(0, rawCount - seenNotiCount) };
  }, [canManage, data, seenNotiCount]);

  const handleTabChange = (tab: TabType) => {
    triggerHaptic('light');
    if (activeTab === tab && tab === 'contacts') { setContactsResetTrigger((value) => value + 1); return; }
    if (activeTab !== tab) {
      setIsHeaderVisible(true);
      const activeIndex = EMPLOYEE_NAV_TABS.indexOf(activeTab);
      const fallbackIndex = EMPLOYEE_NAV_TABS.indexOf(lastActiveTab);
      const targetIndex = EMPLOYEE_NAV_TABS.indexOf(tab);
      const sourceIndex = activeIndex >= 0 ? activeIndex : fallbackIndex;
      setDirection(targetIndex >= 0 && targetIndex > sourceIndex ? 'right' : 'left');
      if (activeTab !== 'profile' && activeTab !== 'notifications') setLastActiveTab(activeTab);
      setActiveTab(tab);
      if (activeTab === 'contacts') setContactsSearchTrigger(0);
    }
    if (tab === 'notifications') {
      setSeenNotiCount(rawNotiCount);
      localStorage.setItem(notificationStorageKey, String(rawNotiCount));
    }
    if (showCreateRequestModal) setShowCreateRequestModal(false);
    if (showExplainWorkModal) setShowExplainWorkModal(false);
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
    setIsAttendanceProcessing(true);
    setIsProcessOverlayVisible(true);
    setCheckInStatus(status);
    return true;
  };

  const finishAttendanceTransaction = () => {
    attendanceLockRef.current = false;
    setIsAttendanceProcessing(false);
    setIsProcessOverlayVisible(false);
  };

  const validateAttendancePosition = (position: GeolocationPosition) => {
    const { accuracy } = position.coords;
    if (!Number.isFinite(accuracy) || accuracy <= 0 || accuracy > TMS_LIMITS.MAX_GPS_ACCURACY_METERS) {
      throw new Error(`Tín hiệu GPS chưa đủ chính xác (±${Math.round(accuracy)}m). Hãy ra nơi thoáng và thử lại.`);
    }
    // Geofence, assigned location and allowed-location decisions are server-only.
    // This avoids rejecting staff who are legitimately assigned to another branch.
  };

  const handleQRScan = async (qrString: string) => {
    setShowQRScanner(false);
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
    setShowCheckoutConfirm(false);
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
    setShowQRScanner(true);
  };

  const openCheckoutConfirm = () => {
    if (attendanceLockRef.current) { setIsProcessOverlayVisible(true); return; }
    if (!navigator.onLine || !isOnline) {
      handleShowAlert('Không có kết nối', 'Check-out cần kết nối mạng để nhận xác nhận từ hệ thống.', 'error');
      return;
    }
    setShowCheckoutConfirm(true);
  };

  if (loading) return <LoadingScreen />;
  if (!data) return <div className="h-full w-full page-bg flex items-center justify-center p-6"><div className="empty-state-card"><span className="material-symbols-rounded empty-state-icon" aria-hidden="true">cloud_off</span><h2>Không tải được dữ liệu</h2><p>{error || 'Vui lòng kiểm tra kết nối rồi thử lại.'}</p><button type="button" className="btn btn-primary btn-md" onClick={() => void refresh(true)}>Thử lại</button></div></div>;

  return <div className="employee-shell" aria-busy={isAttendanceProcessing}>
    {isAttendanceProcessing && isProcessOverlayVisible ? <div className="app-process-backdrop animate-fade-in"><div className="app-process-dialog animate-scale-in" role="status" aria-live="polite"><Spinner size="lg" /><h3>Đang xử lý…</h3><p>{checkInStatus || 'Vui lòng đợi trong giây lát'}</p><small>Không đóng ứng dụng cho đến khi có xác nhận.</small><button type="button" onClick={() => setIsProcessOverlayVisible(false)}>Ẩn đi · vẫn chạy nền</button></div></div> : null}
    {isAttendanceProcessing && !isProcessOverlayVisible ? <button type="button" onClick={() => setIsProcessOverlayVisible(true)} className="app-processing-pill" aria-label="Mở trạng thái chấm công"><span className="app-processing-spinner" aria-hidden="true" />Đang chấm công</button> : null}
    {activeTab !== 'profile' && isHeaderVisible && <Header user={currentUser} activeTab={activeTab} notificationCount={badgeCount} isOnline={isOnline} locationName={locationNames[currentUser.center_id]} onOpenProfile={() => handleTabChange('profile')} onOpenNotifications={() => activeTab === 'notifications' ? setActiveTab(lastActiveTab) : handleTabChange('notifications')} onContactSearch={() => setContactsSearchTrigger((value) => value + 1)} canManage={canManage} onOpenManager={() => handleTabChange('manager')} onOpenWorkspace={onOpenWorkspace} />}
    <div className="employee-scroll"><div className="employee-motion-stage"><AnimatePresence initial={false} custom={direction}><motion.div key={activeTab} custom={direction} initial={{ x: direction === 'right' ? UI_MOTION.PAGE_OFFSET_FORWARD : UI_MOTION.PAGE_OFFSET_BACKWARD }} animate={{ x: 0 }} exit={{ x: direction === 'right' ? UI_MOTION.PAGE_OFFSET_BACKWARD : UI_MOTION.PAGE_OFFSET_FORWARD }} transition={UI_MOTION.PAGE_TRANSITION} className="employee-view"><Suspense fallback={<div className="app-loading-screen"><Spinner size="lg" /></div>}>
      {activeTab === 'home' && <TabHome data={data} loading={loading} onCheckOut={openCheckoutConfirm} onScanKiosk={openQrScanner} onRefresh={refresh} onAlert={handleShowAlert} onExplain={(date, reason) => { setExplainWorkInitialData({ date, reason }); setShowExplainWorkModal(true); }} explainableItems={explainableItems} onNavigate={handleTabChange} onCreateRequest={(type) => { setCreateRequestType(type); setShowCreateRequestModal(true); }} />}
      {activeTab === 'history' && <TabHistory data={data} onRefresh={refresh} onAlert={handleShowAlert} onExplain={(date, reason) => { setExplainWorkInitialData({ date, reason }); setShowExplainWorkModal(true); }} />}
      {activeTab === 'requests' && <TabRequests data={data} user={currentUser} onRefresh={refresh} onCreateRequest={(type) => { setCreateRequestType(type); setShowCreateRequestModal(true); }} onCreateExplanation={() => { setExplainWorkInitialData(null); setShowExplainWorkModal(true); }} />}
      {activeTab === 'calendar' && <CalendarPage data={data} user={currentUser} onRefresh={refresh} currentDate={managerDate} />}
      {activeTab === 'contacts' && <TabContacts data={data} resetTrigger={contactsResetTrigger} searchTrigger={contactsSearchTrigger} setIsHeaderVisible={setIsHeaderVisible} onNavigate={handleTabChange} />}
      {activeTab === 'manager' && <TabManager data={data} user={currentUser} onRefresh={refresh} onAlert={handleShowAlert} />}
      {activeTab === 'profile' && <TabProfile user={currentUser} locations={data.locations || []} locationNames={locationNames} contacts={data.contacts || []} punctuality={punctuality} onLogout={onLogout} onUpdate={(profile) => { updateProfile(profile); void refresh(); }} onClose={() => { setDirection('left'); setActiveTab(lastActiveTab); }} onAlert={handleShowAlert} setShowImageCropper={setShowImageCropper} onOpenManager={() => handleTabChange('manager')} />}
      {activeTab === 'notifications' && <NotificationsModal data={data} user={currentUser} onSwitchTab={handleTabChange} onRefresh={refresh} />}
    </Suspense></motion.div></AnimatePresence></div></div>
    <Suspense fallback={null}>{showCreateRequestModal && <ModalCreateRequest user={currentUser} isOpen initialType={createRequestType} onClose={() => setShowCreateRequestModal(false)} onSuccess={refresh} onAlert={handleShowAlert} onNavigate={handleTabChange} data={data} />} {showExplainWorkModal && <ModalExplainWork isOpen onClose={() => setShowExplainWorkModal(false)} onSuccess={refresh} onAlert={handleShowAlert} initialData={explainWorkInitialData || undefined} explainableItems={explainableItems} sourceTab={activeTab === 'requests' ? 'requests' : 'history'} onNavigate={handleTabChange} data={data} />}</Suspense>
    {activeTab !== 'profile' && !showCheckoutConfirm && !showImageCropper && <><div className="employee-nav-fade" /><BottomNav activeTab={activeTab} onChange={handleTabChange} /></>}
    <Suspense fallback={null}>{showQRScanner && <ModalQRScanner onClose={() => setShowQRScanner(false)} onScan={handleQRScan} onError={(message) => handleShowAlert('Lỗi thiết bị', message, 'error')} />}</Suspense>
    <ConfirmDialog isOpen={showCheckoutConfirm} title="Kết thúc ca làm việc?" message="Hệ thống sẽ ghi nhận giờ ra (Check-out)." confirmLabel="Xác nhận" onConfirm={processCheckOut} onCancel={() => setShowCheckoutConfirm(false)} type="danger" />
  </div>;
};

export default AppShell;
