import { useEffect, useRef, useState } from 'react';

export const PWA_UPDATE_AVAILABLE_EVENT = 'genai:pwa-update-available';
export const ATTENDANCE_ACTIVITY_EVENT = 'genai:attendance-activity';
export const DASHBOARD_SYNC_STATE_EVENT = 'genai:dashboard-sync-state';

export interface PwaUpdateAvailableDetail {
  apply: () => void;
}

export interface DashboardSyncStateDetail {
  error: string | null;
  lastSyncedAt: string | null;
  retry?: () => void;
}

export default function AppStatusBanner() {
  const [isOnline, setIsOnline] = useState(() => navigator.onLine);
  const [connectionRestored, setConnectionRestored] = useState(false);
  const [updateAction, setUpdateAction] = useState<(() => void) | null>(null);
  const [isApplyingUpdate, setIsApplyingUpdate] = useState(false);
  const [isAttendanceActive, setIsAttendanceActive] = useState(false);
  const [dashboardSync, setDashboardSync] = useState<DashboardSyncStateDetail | null>(null);
  const restoredTimerRef = useRef<number | null>(null);
  const updateDismissedRef = useRef(false);

  useEffect(() => {
    const clearRestoredTimer = () => {
      if (restoredTimerRef.current !== null) window.clearTimeout(restoredTimerRef.current);
      restoredTimerRef.current = null;
    };
    const handleOffline = () => {
      clearRestoredTimer();
      setConnectionRestored(false);
      setIsOnline(false);
    };
    const handleOnline = () => {
      setIsOnline(true);
      setConnectionRestored(true);
      clearRestoredTimer();
      restoredTimerRef.current = window.setTimeout(() => setConnectionRestored(false), 3_000);
    };
    const handleUpdate = (event: Event) => {
      if (updateDismissedRef.current) return;
      const detail = (event as CustomEvent<PwaUpdateAvailableDetail>).detail;
      if (typeof detail?.apply === 'function') setUpdateAction(() => detail.apply);
    };
    const handleAttendanceActivity = (event: Event) => {
      const detail = (event as CustomEvent<{ active?: boolean }>).detail;
      setIsAttendanceActive(Boolean(detail?.active));
    };
    const handleDashboardSync = (event: Event) => {
      const detail = (event as CustomEvent<DashboardSyncStateDetail>).detail;
      setDashboardSync(detail?.error ? detail : null);
    };

    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);
    window.addEventListener(PWA_UPDATE_AVAILABLE_EVENT, handleUpdate);
    window.addEventListener(ATTENDANCE_ACTIVITY_EVENT, handleAttendanceActivity);
    window.addEventListener(DASHBOARD_SYNC_STATE_EVENT, handleDashboardSync);
    return () => {
      clearRestoredTimer();
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener(PWA_UPDATE_AVAILABLE_EVENT, handleUpdate);
      window.removeEventListener(ATTENDANCE_ACTIVITY_EVENT, handleAttendanceActivity);
      window.removeEventListener(DASHBOARD_SYNC_STATE_EVENT, handleDashboardSync);
    };
  }, []);

  const applyUpdate = () => {
    if (!updateAction || isApplyingUpdate || isAttendanceActive || !isOnline) return;
    setIsApplyingUpdate(true);
    updateAction();
  };

  if (isOnline && !connectionRestored && !updateAction && !dashboardSync) return null;

  const lastSyncedLabel = dashboardSync?.lastSyncedAt
    ? new Date(dashboardSync.lastSyncedAt).toLocaleTimeString('vi-VN', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
    : null;

  return (
    <div
      className="app-status-stack"
      aria-live="polite"
      aria-atomic="true"
    >
      {!isOnline ? (
        <div className="app-status-banner app-status-banner-warning" role="alert">
          <span className="material-symbols-rounded" aria-hidden="true">wifi_off</span>
          <div className="app-status-banner-body">
            <strong>Đang ngoại tuyến</strong>
            <span>Bạn vẫn có thể xem dữ liệu đã tải. Chấm công và cập nhật dữ liệu đang tạm khóa.</span>
          </div>
        </div>
      ) : connectionRestored ? (
        <div className="app-status-banner app-status-banner-success" role="status">
          <span className="material-symbols-rounded" aria-hidden="true">wifi</span>
          <strong>Đã kết nối lại</strong>
        </div>
      ) : null}

      {updateAction ? (
        <div className="app-status-banner app-status-banner-info" role="status">
          <span className="material-symbols-rounded ui-tone-info" aria-hidden="true">system_update</span>
          <div className="app-status-banner-body">
            <strong>Có phiên bản mới</strong>
            <span>{!isOnline ? 'Kết nối mạng để cài đặt phiên bản mới.' : isAttendanceActive ? 'Sẽ mở lại sau khi hoàn tất chấm công.' : 'Cập nhật khi bạn không thực hiện chấm công.'}</span>
          </div>
          <button
            type="button"
            className="app-status-banner-action"
            onClick={applyUpdate}
            disabled={isApplyingUpdate || isAttendanceActive || !isOnline}
          >
            {isApplyingUpdate ? 'Đang cập nhật…' : !isOnline ? 'Đang ngoại tuyến' : isAttendanceActive ? 'Đang chấm công' : 'Cập nhật'}
          </button>
          <button
            type="button"
            className="app-status-banner-dismiss"
            onClick={() => {
              updateDismissedRef.current = true;
              setUpdateAction(null);
            }}
            aria-label="Để sau"
          >
            <span className="material-symbols-rounded" aria-hidden="true">close</span>
          </button>
        </div>
      ) : null}

      {isOnline && dashboardSync ? (
        <div className="app-status-banner app-status-banner-warning" role="status">
          <span className="material-symbols-rounded" aria-hidden="true">sync_problem</span>
          <div className="app-status-banner-body">
            <strong>Dữ liệu chưa đồng bộ</strong>
            <span>{lastSyncedLabel ? `Bản gần nhất lúc ${lastSyncedLabel}.` : 'Chưa có bản đồng bộ thành công.'}</span>
          </div>
          {dashboardSync.retry ? (
            <button type="button" className="app-status-banner-action" onClick={dashboardSync.retry}>
              Thử lại
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
