import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'react-qr-code';
import { createAttendanceQr, getQrTimingConfig } from '@/modules/tms/services/attendance';
import { getActiveLocations } from '@/modules/tms/services/locations';
import { APP_INFO, TMS_LIMITS } from '@/shared/constants';
import type { Employee, Location } from '@/shared/types';

interface ScreenWakeLock {
  release: () => Promise<void>;
  addEventListener: (type: 'release', listener: () => void) => void;
}

type NavigatorWithWakeLock = Navigator & {
  wakeLock?: { request: (type: 'screen') => Promise<ScreenWakeLock> };
};

export default function QrStation({
  user,
  onExit,
}: {
  user: Employee;
  onExit: () => void;
}) {
  const [payload, setPayload] = useState('');
  const [expiresAt, setExpiresAt] = useState(0);
  const [branchName, setBranchName] = useState('');
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState('');
  const [isOnline, setIsOnline] = useState(() => navigator.onLine);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [isFullscreen, setIsFullscreen] = useState(() => Boolean(document.fullscreenElement));
  const [isWakeLockActive, setIsWakeLockActive] = useState(false);
  const [locations, setLocations] = useState<Location[]>([]);
  const [selectedCenter, setSelectedCenter] = useState(user.center_id);
  const [timing, setTiming] = useState<{ refreshMs: number; validitySeconds: number }>({
    refreshMs: TMS_LIMITS.QR_REFRESH_MS,
    validitySeconds: TMS_LIMITS.QR_VALIDITY_SECONDS,
  });
  const requestInFlight = useRef(false);
  const wakeLockRef = useRef<ScreenWakeLock | null>(null);

  useEffect(() => {
    void getQrTimingConfig().then(setTiming);
    void getActiveLocations()
      .then((items) => {
        setLocations(items);
        if (!items.some((item) => item.center_id === user.center_id) && items[0]) {
          setSelectedCenter(items[0].center_id);
        }
      })
      .catch((requestError) => setError(requestError instanceof Error ? requestError.message : 'Không tải được địa điểm.'));
  }, [user.center_id]);

  const refresh = useCallback(async () => {
    if (requestInFlight.current) return;
    if (!navigator.onLine) {
      setIsOnline(false);
      setPayload('');
      setExpiresAt(0);
      setError('Trạm đang ngoại tuyến. Mã QR đã được ẩn để tránh chấm công bằng mã hết hạn.');
      return;
    }

    requestInFlight.current = true;
    setIsRefreshing(true);
    try {
      if (!selectedCenter) throw new Error('Chưa có địa điểm để mở trạm QR.');
      const result = await createAttendanceQr(selectedCenter);
      setPayload(result.payload);
      setExpiresAt(result.expiresAt);
      setBranchName(result.branchName);
      setLastRefreshedAt(new Date());
      setIsOnline(true);
      setError('');
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : 'Không tạo được mã QR.';
      setError(message);
    } finally {
      requestInFlight.current = false;
      setIsRefreshing(false);
    }
  }, [selectedCenter]);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), timing.refreshMs);
    return () => window.clearInterval(interval);
  }, [refresh, timing.refreshMs]);

  useEffect(() => {
    const update = () => {
      setNow(new Date());
      setSeconds(Math.max(0, Math.ceil((expiresAt - Date.now()) / TMS_LIMITS.CLOCK_REFRESH_MS)));
    };
    update();
    const interval = window.setInterval(update, TMS_LIMITS.CLOCK_REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [expiresAt]);

  useEffect(() => {
    const handleOffline = () => {
      setIsOnline(false);
      setPayload('');
      setExpiresAt(0);
      setError('Trạm đang ngoại tuyến. Mã QR đã được ẩn để tránh chấm công bằng mã hết hạn.');
    };
    const handleOnline = () => {
      setIsOnline(true);
      void refresh();
    };
    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);
    return () => {
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
    };
  }, [refresh]);

  const requestWakeLock = useCallback(async () => {
    if (document.visibilityState !== 'visible' || wakeLockRef.current) return;
    try {
      const wakeLock = await (navigator as NavigatorWithWakeLock).wakeLock?.request('screen');
      if (!wakeLock) return;
      wakeLockRef.current = wakeLock;
      setIsWakeLockActive(true);
      wakeLock.addEventListener('release', () => {
        if (wakeLockRef.current === wakeLock) wakeLockRef.current = null;
        setIsWakeLockActive(false);
      });
    } catch {
      // Wake lock support is optional; the station remains functional without it.
    }
  }, []);

  useEffect(() => {
    void requestWakeLock();
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') void requestWakeLock();
    };
    const handleFullscreenChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('visibilitychange', handleVisibilityChange);
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      const wakeLock = wakeLockRef.current;
      wakeLockRef.current = null;
      if (wakeLock) void wakeLock.release();
    };
  }, [requestWakeLock]);

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
      await requestWakeLock();
    } catch {
      // Fullscreen is best-effort and can be denied by browser or device policy.
    }
  };

  const handleExit = async () => {
    if (document.fullscreenElement) {
      try {
        await document.exitFullscreen();
      } catch {
        // Continue exiting the station even if fullscreen cannot be closed programmatically.
      }
    }
    onExit();
  };

  return (
    <main className="station-page">
      <header className="station-topbar">
        <div className="brand-lockup brand-lockup-compact">
          <img className="brand-logo brand-logo-compact" src={APP_INFO.LOGO_URL} alt={APP_INFO.BRAND} />
          <div>
            <p className="eyebrow">Workspace</p>
            <strong>Trạm QR động</strong>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 sm:gap-3">
          <div className="hidden text-right sm:block" aria-label="Thời gian hiện tại">
            <strong className="block font-mono text-base tabular-nums">{now.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}</strong>
            <span className="block text-[11px] opacity-60">{isWakeLockActive ? 'Màn hình luôn bật' : 'Trạm chấm công'}</span>
          </div>
          {document.fullscreenEnabled ? (
            <button type="button" className="button button-secondary" onClick={() => void toggleFullscreen()} aria-label={isFullscreen ? 'Thoát toàn màn hình' : 'Mở toàn màn hình'}>
              <span className="material-symbols-rounded" aria-hidden="true">{isFullscreen ? 'fullscreen_exit' : 'fullscreen'}</span>
              <span className="hidden md:inline">{isFullscreen ? 'Thu nhỏ' : 'Toàn màn hình'}</span>
            </button>
          ) : null}
          <button type="button" className="button button-secondary" onClick={() => void handleExit()}>
            <span className="material-symbols-rounded" aria-hidden="true">logout</span>
            Thoát
          </button>
        </div>
      </header>

      <section className="station-content" aria-live="polite">
        <div className="station-heading">
          <p className="eyebrow">Trạm chấm công</p>
          <h1>{branchName || user.center_id || 'Chưa gán chi nhánh'}</h1>
          {!isOnline ? (
            <div className="ui-pill ui-pill-warning station-offline-pill" role="status">
              <span className="material-symbols-rounded text-base" aria-hidden="true">wifi_off</span>
              Ngoại tuyến · QR đã tạm khóa
            </div>
          ) : !error && Boolean(payload) ? <div className="ga-station-status"><i /><span>Đang hoạt động</span></div> : null}
          <p className="muted">Mở {APP_INFO.NAME}, quét mã và bật định vị để xác thực.</p>
          {locations.length > 1 && (
            <select
              className="station-location-select"
              value={selectedCenter}
              disabled={!isOnline || isRefreshing}
              onChange={(event) => {
                setSelectedCenter(event.target.value);
                setPayload('');
                setExpiresAt(0);
              }}
              aria-label="Chọn địa điểm trạm QR"
            >
              {locations.map((location) => (
                <option value={location.center_id} key={location.center_id}>{location.center_name}</option>
              ))}
            </select>
          )}
        </div>

        <div className="qr-panel">
          {error ? (
            <div className="station-error">
              <span className="material-symbols-rounded" aria-hidden="true">error</span>
              <p>{error}</p>
              <button type="button" className="button button-primary" onClick={() => void refresh()} disabled={!isOnline || isRefreshing}>
                {!isOnline ? 'Đang chờ kết nối' : isRefreshing ? 'Đang làm mới…' : 'Thử lại'}
              </button>
            </div>
          ) : payload && seconds > 0 ? (
            <>
              <div className="qr-code">
                <QRCode value={payload} size={TMS_LIMITS.KIOSK_QR_SIZE_PX} level="M" />
              </div>
              <div className="qr-countdown">
                <span className={seconds <= Math.ceil(timing.validitySeconds * 0.2) ? 'countdown-warning' : ''}>{seconds}s</span>
                <p>Mã tự làm mới mỗi {Math.round(timing.refreshMs / TMS_LIMITS.CLOCK_REFRESH_MS)} giây · hiệu lực tối đa {timing.validitySeconds} giây</p>
                {lastRefreshedAt ? <p className="mt-1 text-xs opacity-60">Cập nhật gần nhất lúc {lastRefreshedAt.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}</p> : null}
              </div>
            </>
          ) : (
            <div className="station-loading">
              <span className="spinner" aria-hidden="true" />
              <p>Đang tạo mã bảo mật...</p>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
