import React, { Suspense, lazy, useCallback, useEffect, useState, useRef, useMemo } from 'react';
import type { Employee, Explanation, LeaveRequest } from '@/shared/types';
import { doCheckOut } from '@/modules/tms/services/employee';
import { recordQrAttendance } from '@/modules/tms/services/attendance';
import { triggerHaptic, playAudioChime, calculateDistance, getCurrentTimeStr, toISODateString } from '@/core/utils/helpers';
import { useDashboardData } from '@/modules/tms/hooks/useDashboardData';
import { useToast } from '@/shared/contexts/useToast';
import { motion, AnimatePresence } from 'framer-motion';
import TabHome from '@/modules/tms/pages/Home';
import BottomNav, { EMPLOYEE_NAV_TABS, type RegisterSwipeHandler, type SwipeDirection, type SwipeHandler, type TabType } from './BottomNav';
import Header from './Header';
import ConfirmDialog from '@/shared/components/modals/ConfirmDialog';
import Spinner from '@/shared/components/common/Spinner';
import { MANAGEMENT_ROLES, SCOPED_MANAGEMENT_ROLES, STORAGE_KEYS, TMS_LIMITS, UI_MOTION } from '@/shared/constants';
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
  if (!value) return getCurrentTimeStr();
  const match = value.match(/\b(\d{1,2}:\d{2})\b/);
  return match?.[1] || value;
}

function blocksGlobalSwipe(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest('input, textarea, select, button, a, [role="button"]')) return true;

  let element: HTMLElement | null = target;
  while (element && element !== document.body) {
    const overflowX = window.getComputedStyle(element).overflowX;
    if ((overflowX === 'auto' || overflowX === 'scroll') && element.scrollWidth > element.clientWidth) return true;
    element = element.parentElement;
  }
  return false;
}

const AppShell: React.FC<Props> = ({ user, onLogout, onOpenWorkspace }) => {
  const { updateProfile } = useAuth();
  const { showToast } = useToast();
  const handleShowAlert = useCallback((title: string, msg: string, type: 'success' | 'error' | 'warning' | 'info' = 'success') => {
    triggerHaptic(type === 'success' ? 'success' : type === 'warning' ? 'warning' : 'error');
    if (type === 'success') {
      playAudioChime('success');
    } else if (type === 'error' || type === 'warning') {
      playAudioChime('error');
    }
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
  const [showExplainWorkModal, setShowExplainWorkModal] = useState(false);
  const [explainWorkInitialData, setExplainWorkInitialData] = useState<{ date: string, reason: string } | null>(null);
  const [contactsResetTrigger, setContactsResetTrigger] = useState(0);
  const [contactsSearchTrigger, setContactsSearchTrigger] = useState(0);
  const [seenNotiCount, setSeenNotiCount] = useState(() => { try { return parseInt(localStorage.getItem(STORAGE_KEYS.SEEN_NOTIFICATIONS) || '0', 10); } catch { return 0; } });
  const managerDate = new Date();
  const touchStart = useRef<{ x: number, y: number, allowGlobalNavigation: boolean } | null>(null);
  const touchEnd = useRef<{ x: number, y: number } | null>(null);
  const swipeHandlerRef = useRef<SwipeHandler | null>(null);
  const attendanceLockRef = useRef(false);
  const registerSwipeHandler: RegisterSwipeHandler = useCallback((handler) => {
    swipeHandlerRef.current = handler;
    return () => {
      if (swipeHandlerRef.current === handler) swipeHandlerRef.current = null;
    };
  }, []);
  const canManage = useMemo(() => !!(currentUser?.role && MANAGEMENT_ROLES.includes(currentUser.role)), [currentUser]);

  useEffect(() => {
    const active = isAttendanceProcessing || showQRScanner || showCheckoutConfirm;
    window.dispatchEvent(new CustomEvent(ATTENDANCE_ACTIVITY_EVENT, { detail: { active } }));
    return () => {
      if (active) window.dispatchEvent(new CustomEvent(ATTENDANCE_ACTIVITY_EVENT, { detail: { active: false } }));
    };
  }, [isAttendanceProcessing, showCheckoutConfirm, showQRScanner]);

  const { rawNotiCount, badgeCount } = useMemo(() => {
    if (!data) return { rawNotiCount: 0, badgeCount: 0 };
    const { notifications, contacts } = data;
    const managedLocationsSet = new Set(currentUser.managed_locations || []);
    let visibleApprovals = 0;
    if (currentUser.role === 'Admin' || currentUser.role === 'HR') visibleApprovals = notifications.approvals.length + notifications.explanationApprovals.length;
    else if (SCOPED_MANAGEMENT_ROLES.includes(currentUser.role)) {
      const filterByUserScope = (approval: LeaveRequest | Explanation) => {
        const emp = contacts.find(c => c.employee_id === approval.employee_id);
        if (!emp) return false;
        return String(emp.direct_manager_id) === String(currentUser.employee_id) || (!!emp.center_id && managedLocationsSet.has(emp.center_id));
      };
      visibleApprovals = notifications.approvals.filter(filterByUserScope).length + notifications.explanationApprovals.filter(filterByUserScope).length;
    }
    const personal = notifications.myRequests.filter(r => r.status !== 'Pending').length + notifications.myExplanations.filter(r => r.status !== 'Pending').length;
    const rawCount = visibleApprovals + personal;
    return { rawNotiCount: rawCount, badgeCount: Math.max(0, rawCount - seenNotiCount) };
  }, [data, currentUser, seenNotiCount]);

  const handleTabChange = (tab: TabType) => {
    triggerHaptic('light');
    if (activeTab === tab && tab === 'contacts') { setContactsResetTrigger(v => v + 1); return; }
    if (activeTab !== tab) {
      swipeHandlerRef.current = null;
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
    if (tab === 'notifications') { setSeenNotiCount(rawNotiCount); localStorage.setItem(STORAGE_KEYS.SEEN_NOTIFICATIONS, String(rawNotiCount)); }
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
    const { accuracy, latitude, longitude } = position.coords;
    if (!Number.isFinite(accuracy) || accuracy <= 0 || accuracy > TMS_LIMITS.MAX_GPS_ACCURACY_METERS) {
      throw new Error(`Tín hiệu GPS chưa đủ chính xác (±${Math.round(accuracy)}m). Hãy ra nơi thoáng và thử lại.`);
    }

    const location = data?.locations?.find(item => item.center_id === currentUser.center_id);
    if (location) {
      const distance = calculateDistance(latitude, longitude, Number(location.latitude), Number(location.longitude));
      const maxDistance = Number(location.radius_meters || data?.systemConfig?.MAX_DISTANCE_METERS || TMS_LIMITS.DEFAULT_GEOFENCE_METERS);
      if (distance > maxDistance) {
        throw new Error(`Bạn đang cách văn phòng ${Math.round(distance)}m, ngoài phạm vi cho phép ${maxDistance}m.`);
      }
    }
    return location;
  };

  const handleQRScan = async (qrString: string) => {
    setShowQRScanner(false);
    if (!beginAttendanceTransaction('Đang kiểm tra GPS và kết nối…')) return;

    try {
      const position = await requestCurrentPosition();
      const location = validateAttendancePosition(position);
      if (!navigator.onLine) throw new Error('Kết nối đã bị gián đoạn. Chưa có dữ liệu chấm công nào được gửi.');

      setCheckInStatus(`GPS ±${Math.round(position.coords.accuracy)}m · Đang gửi yêu cầu bảo mật…`);
      const result = await recordQrAttendance({
        qrPayload: qrString,
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        accuracy: position.coords.accuracy,
      });
      await refresh();

      const actionLabel = result.action === 'checkin' ? 'Check-in' : 'Check-out';
      const recordedAt = receiptTime(result.action === 'checkin' ? result.attendance.time_in : result.attendance.time_out);
      const recordedLocation = result.attendance.location_name || location?.location_name || location?.center_name || currentUser.center_id;
      handleShowAlert(`${actionLabel} thành công`, `${recordedAt} · ${recordedLocation}. ${result.message || 'Hệ thống đã ghi nhận.'}`, 'success');
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
      const location = validateAttendancePosition(position);
      if (!navigator.onLine) throw new Error('Kết nối đã bị gián đoạn. Check-out chưa được gửi.');

      setCheckInStatus(`GPS ±${Math.round(position.coords.accuracy)}m · Đang gửi Check-out…`);
      const result = await doCheckOut({
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        accuracy: position.coords.accuracy,
      });
      if (!result.success) throw new Error(result.message);
      await refresh();

      const recordedLocation = location?.location_name || location?.center_name || currentUser.center_id;
      handleShowAlert('Check-out thành công', `${getCurrentTimeStr()} · ${recordedLocation}. ${result.message}`, 'success');
    } catch (caughtError) {
      handleShowAlert('Check-out thất bại', attendanceErrorMessage(caughtError), 'error');
    } finally {
      finishAttendanceTransaction();
    }
  };

  const resetSwipe = () => {
    touchStart.current = null;
    touchEnd.current = null;
  };
  const onTouchStart = (e: React.TouchEvent) => {
    if (e.targetTouches.length !== 1) { resetSwipe(); return; }
    const touch = e.targetTouches[0];
    if (!touch) { resetSwipe(); return; }
    const point = {
      x: touch.clientX,
      y: touch.clientY,
      allowGlobalNavigation: !blocksGlobalSwipe(e.target),
    };
    touchStart.current = point;
    touchEnd.current = { x: point.x, y: point.y };
  };
  const onTouchMove = (e: React.TouchEvent) => {
    const touch = e.targetTouches[0];
    if (touch) touchEnd.current = { x: touch.clientX, y: touch.clientY };
  };
  const onTouchEnd = () => {
    const start = touchStart.current;
    const end = touchEnd.current;
    resetSwipe();
    if (!start || !end) return;
    const dX = start.x - end.x, dY = start.y - end.y;
    if (Math.abs(dX) > Math.abs(dY) && Math.abs(dX) > TMS_LIMITS.SWIPE_NAVIGATION_PX) {
      const swipeDirection: SwipeDirection = dX > 0 ? 'left' : 'right';
      if (swipeHandlerRef.current?.(swipeDirection)) return;
      if (!start.allowGlobalNavigation) return;
      const currentIndex = EMPLOYEE_NAV_TABS.indexOf(activeTab);
      if (currentIndex < 0) return;
      const targetIndex = currentIndex + (swipeDirection === 'left' ? 1 : -1);
      const targetTab = EMPLOYEE_NAV_TABS[targetIndex];
      if (targetTab) handleTabChange(targetTab);
    }
  };

  const explainableItems = useMemo(() => {
    if (!data) return [];
    const today = new Date(); today.setHours(0,0,0,0);
    const list: { date: string, explainReason: string }[] = [];
    const loop = new Date(); loop.setDate(loop.getDate() - TMS_LIMITS.EXPLANATION_LOOKBACK_DAYS);
    const holidays = Array.isArray(data.holidays) ? data.holidays : [];
    const isHoliday = (dStr: string) => holidays.some(h => (h.active !== false) && dStr >= h.from_date && dStr <= h.to_date);

    while (loop <= today) {
      const dateStr = toISODateString(loop);
      const rows = data.history.history.filter(h => h.date === dateStr);
      const reasons: string[] = [];
      if (rows.length) {
        if (rows.some(r => !r.time_out) && dateStr !== toISODateString(today)) reasons.push('Quên Check-out');
        const late = rows.reduce((s,r)=>s+Number(r.late_minutes||0),0);
        if (late) reasons.push(`Trễ ${late} phút`);
        const early = rows.reduce((s,r)=>s+Number(r.early_minutes||0),0);
        if (early) reasons.push(`Về sớm ${early} phút`);
      } else {
        const off = Array.isArray(data.systemConfig?.OFF_DAYS) ? data.systemConfig.OFF_DAYS : [0,6];
        if (!off.includes(loop.getDay()) && !isHoliday(dateStr)) {
          reasons.push('Vắng');
        }
      }
      const explained = data.myExplanations.some(r => r.date === dateStr && r.status !== 'Rejected');
      const requested = data.myRequests.some(r => {
        const current = new Date(dateStr+'T00:00:00');
        return current >= new Date(r.from_date+'T00:00:00') && current <= new Date(r.to_date+'T00:00:00') && r.status === 'Approved';
      });
      if (reasons.length && !explained && !requested) list.push({ date: dateStr, explainReason: reasons.join(', ') });
      loop.setDate(loop.getDate()+1);
    }

    const lockDate = data.systemConfig?.LOCK_DATE ?? TMS_LIMITS.LOCK_DATE;
    const y = today.getFullYear(), m = today.getMonth();
    // Allow previous month if current day is within lockDate deadline (e.g. day 1 to 5)
    const start = today.getDate() <= lockDate ? new Date(y, m - 1, 1) : new Date(y, m, 1);
    const end = new Date(y, m + 1, lockDate); end.setHours(23, 59, 59, 999);
    return list.filter(i => { const d = new Date(i.date + 'T00:00:00'); return d >= start && d <= end; });
  }, [data]);

  const openQrScanner = () => {
    if (attendanceLockRef.current) {
      setIsProcessOverlayVisible(true);
      return;
    }
    if (!navigator.onLine || !isOnline) {
      handleShowAlert('Không có kết nối', 'Hãy kết nối mạng trước khi quét mã chấm công.', 'error');
      return;
    }
    setShowQRScanner(true);
  };

  const openCheckoutConfirm = () => {
    if (attendanceLockRef.current) {
      setIsProcessOverlayVisible(true);
      return;
    }
    if (!navigator.onLine || !isOnline) {
      handleShowAlert('Không có kết nối', 'Check-out cần kết nối mạng để nhận xác nhận từ hệ thống.', 'error');
      return;
    }
    setShowCheckoutConfirm(true);
  };

  if (loading) return <div className="h-full w-full flex items-center justify-center page-bg"><Spinner size="lg" /></div>;
  if (!data) return <div className="h-full w-full page-bg flex items-center justify-center p-6"><div className="empty-state-card"><span className="material-symbols-rounded empty-state-icon" aria-hidden="true">cloud_off</span><h2>Không tải được dữ liệu</h2><p>{error || 'Vui lòng kiểm tra kết nối rồi thử lại.'}</p><button type="button" className="btn btn-primary btn-md" onClick={() => void refresh(true)}>Thử lại</button></div></div>;

  return <div className="employee-shell" aria-busy={isAttendanceProcessing}>
    {isAttendanceProcessing && isProcessOverlayVisible ? <div className="app-process-backdrop animate-fade-in"><div className="app-process-dialog animate-scale-in" role="status" aria-live="polite"><Spinner size="lg" /><h3>Đang xử lý…</h3><p>{checkInStatus || 'Vui lòng đợi trong giây lát'}</p><small>Không đóng ứng dụng cho đến khi có xác nhận.</small><button type="button" onClick={()=>setIsProcessOverlayVisible(false)}>Ẩn đi · vẫn chạy nền</button></div></div> : null}
    {isAttendanceProcessing && !isProcessOverlayVisible ? <button type="button" onClick={()=>setIsProcessOverlayVisible(true)} className="fixed bottom-[calc(env(safe-area-inset-bottom)+5.75rem)] right-4 z-[90] inline-flex items-center gap-2 rounded-full bg-slate-900 px-4 py-2.5 text-xs font-bold text-white shadow-xl dark:bg-sky-600" aria-label="Mở trạng thái chấm công"><span className="size-3 animate-spin rounded-full border-2 border-white/40 border-t-white" aria-hidden="true" />Đang chấm công</button> : null}
    {activeTab !== 'profile' && isHeaderVisible && <Header user={currentUser} activeTab={activeTab} notificationCount={badgeCount} onOpenProfile={()=>handleTabChange('profile')} onOpenNotifications={()=>activeTab==='notifications'?setActiveTab(lastActiveTab):handleTabChange('notifications')} onCreateRequest={()=>setShowCreateRequestModal(true)} onContactSearch={()=>setContactsSearchTrigger(v=>v+1)} canManage={canManage} onOpenManager={()=>handleTabChange('manager')} onOpenWorkspace={onOpenWorkspace} />}
    <div className="employee-scroll" onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd} onTouchCancel={resetSwipe}><div className="employee-motion-stage"><AnimatePresence initial={false} custom={direction}><motion.div key={activeTab} custom={direction} initial={{x:direction==='right'?UI_MOTION.PAGE_OFFSET_PX:-UI_MOTION.PAGE_OFFSET_PX,opacity:0}} animate={{x:0,opacity:1}} exit={{x:direction==='right'?-UI_MOTION.PAGE_OFFSET_PX:UI_MOTION.PAGE_OFFSET_PX,opacity:0}} transition={UI_MOTION.PAGE_TRANSITION} className="employee-view"><Suspense fallback={<div className="app-loading-screen"><Spinner size="lg" /></div>}>
      {activeTab==='home'&&<TabHome data={data} loading={loading} onCheckOut={openCheckoutConfirm} onScanKiosk={openQrScanner} onRefresh={refresh} onAlert={handleShowAlert} onExplain={(date,reason)=>{setExplainWorkInitialData({date,reason});setShowExplainWorkModal(true);}} explainableItems={explainableItems}/>} 
      {activeTab==='history'&&<TabHistory data={data} onRefresh={refresh} onAlert={handleShowAlert} onExplain={(date,reason)=>{setExplainWorkInitialData({date,reason});setShowExplainWorkModal(true);}} registerSwipeHandler={registerSwipeHandler}/>}
      {activeTab==='requests'&&<TabRequests data={data} user={currentUser} onRefresh={refresh} registerSwipeHandler={registerSwipeHandler}/>} 
      {activeTab==='calendar'&&<CalendarPage data={data} user={currentUser} onRefresh={refresh} currentDate={managerDate}/>}
      {activeTab==='contacts'&&<TabContacts data={data} user={currentUser} resetTrigger={contactsResetTrigger} searchTrigger={contactsSearchTrigger} setIsHeaderVisible={setIsHeaderVisible} registerSwipeHandler={registerSwipeHandler} onNavigate={handleTabChange}/>}
      {activeTab==='manager'&&<TabManager data={data} user={currentUser} onRefresh={refresh} onAlert={handleShowAlert}/>}
      {activeTab==='profile'&&<TabProfile user={currentUser} locations={data.locations||[]} contacts={data.contacts||[]} onLogout={onLogout} onUpdate={(profile)=>{updateProfile(profile);void refresh();}} onClose={()=>{setDirection('left');setActiveTab(lastActiveTab);}} onAlert={handleShowAlert} setShowImageCropper={setShowImageCropper} onOpenManager={()=>handleTabChange('manager')}/>}
      {activeTab==='notifications'&&<NotificationsModal data={data} user={currentUser} onSwitchTab={handleTabChange} onRefresh={refresh}/>}
    </Suspense></motion.div></AnimatePresence></div></div>
    <Suspense fallback={null}>{showCreateRequestModal&&<ModalCreateRequest user={currentUser} isOpen onClose={()=>setShowCreateRequestModal(false)} onSuccess={refresh} onAlert={handleShowAlert} onNavigate={handleTabChange} data={data}/>} {showExplainWorkModal&&<ModalExplainWork isOpen onClose={()=>setShowExplainWorkModal(false)} onSuccess={refresh} onAlert={handleShowAlert} initialData={explainWorkInitialData||undefined} explainableItems={explainableItems} onNavigate={handleTabChange} data={data}/>}</Suspense>
    {!showCheckoutConfirm&&!showImageCropper&&<><div className="employee-nav-fade"/><BottomNav activeTab={activeTab} onChange={handleTabChange}/></>}
    <Suspense fallback={null}>{showQRScanner&&<ModalQRScanner onClose={()=>setShowQRScanner(false)} onScan={handleQRScan} onError={msg=>handleShowAlert('Lỗi thiết bị',msg,'error')}/>}</Suspense>
    <ConfirmDialog isOpen={showCheckoutConfirm} title="Kết thúc ca làm việc?" message="Hệ thống sẽ ghi nhận giờ ra (Check-out)." confirmLabel="Xác nhận" onConfirm={processCheckOut} onCancel={()=>setShowCheckoutConfirm(false)} type="danger"/>
  </div>;
};
export default AppShell;
