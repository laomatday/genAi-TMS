import { useEffect, useRef, useState } from 'react';

export const PWA_UPDATE_AVAILABLE_EVENT = 'genai:pwa-update-available';
export const ATTENDANCE_ACTIVITY_EVENT = 'genai:attendance-activity';

export interface PwaUpdateAvailableDetail {
  apply: () => void;
}

export default function AppStatusBanner() {
  const [isOnline, setIsOnline] = useState(() => navigator.onLine);
  const [connectionRestored, setConnectionRestored] = useState(false);
  const [updateAction, setUpdateAction] = useState<(() => void) | null>(null);
  const [isApplyingUpdate, setIsApplyingUpdate] = useState(false);
  const [isAttendanceActive, setIsAttendanceActive] = useState(false);
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

    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);
    window.addEventListener(PWA_UPDATE_AVAILABLE_EVENT, handleUpdate);
    window.addEventListener(ATTENDANCE_ACTIVITY_EVENT, handleAttendanceActivity);
    return () => {
      clearRestoredTimer();
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener(PWA_UPDATE_AVAILABLE_EVENT, handleUpdate);
      window.removeEventListener(ATTENDANCE_ACTIVITY_EVENT, handleAttendanceActivity);
    };
  }, []);

  const applyUpdate = () => {
    if (!updateAction || isApplyingUpdate || isAttendanceActive || !isOnline) return;
    setIsApplyingUpdate(true);
    updateAction();
  };

  if (isOnline && !connectionRestored && !updateAction) return null;

  return (
    <div
      className="pointer-events-none fixed inset-x-3 top-[calc(env(safe-area-inset-top)+0.75rem)] z-[9999] mx-auto flex max-w-xl flex-col gap-2"
      aria-live="polite"
      aria-atomic="true"
    >
      {!isOnline ? (
        <div className="pointer-events-auto flex items-center gap-3 rounded-2xl border border-amber-300/70 bg-amber-50 px-4 py-3 text-sm text-amber-950 shadow-xl dark:border-amber-500/40 dark:bg-amber-950 dark:text-amber-50" role="alert">
          <span className="material-symbols-rounded" aria-hidden="true">wifi_off</span>
          <div className="min-w-0 flex-1">
            <strong className="block">Đang ngoại tuyến</strong>
            <span className="block text-xs opacity-80">Bạn vẫn có thể xem dữ liệu đã tải. Chấm công và cập nhật dữ liệu đang tạm khóa.</span>
          </div>
        </div>
      ) : connectionRestored ? (
        <div className="pointer-events-auto flex items-center gap-3 rounded-2xl border border-emerald-300/70 bg-emerald-50 px-4 py-3 text-sm text-emerald-950 shadow-xl dark:border-emerald-500/40 dark:bg-emerald-950 dark:text-emerald-50" role="status">
          <span className="material-symbols-rounded" aria-hidden="true">wifi</span>
          <strong>Đã kết nối lại</strong>
        </div>
      ) : null}

      {updateAction ? (
        <div className="pointer-events-auto flex items-center gap-3 rounded-2xl border border-sky-300/70 bg-white px-4 py-3 text-sm text-slate-900 shadow-xl dark:border-sky-500/40 dark:bg-slate-900 dark:text-slate-50" role="status">
          <span className="material-symbols-rounded text-sky-600 dark:text-sky-400" aria-hidden="true">system_update</span>
          <div className="min-w-0 flex-1">
            <strong className="block">Có phiên bản mới</strong>
            <span className="block text-xs text-slate-500 dark:text-slate-400">{!isOnline ? 'Kết nối mạng để cài đặt phiên bản mới.' : isAttendanceActive ? 'Sẽ mở lại sau khi hoàn tất chấm công.' : 'Cập nhật khi bạn không thực hiện chấm công.'}</span>
          </div>
          <button
            type="button"
            className="rounded-full bg-sky-600 px-3 py-2 text-xs font-bold text-white disabled:cursor-wait disabled:opacity-60"
            onClick={applyUpdate}
            disabled={isApplyingUpdate || isAttendanceActive || !isOnline}
          >
            {isApplyingUpdate ? 'Đang cập nhật…' : !isOnline ? 'Đang ngoại tuyến' : isAttendanceActive ? 'Đang chấm công' : 'Cập nhật'}
          </button>
          <button
            type="button"
            className="grid size-9 place-items-center rounded-full text-slate-500 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
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
    </div>
  );
}
