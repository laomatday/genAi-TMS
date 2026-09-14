import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { DashboardData } from '@/shared/types';
import {
  formatDateString,
  getCurrentTimeStr,
  timeToMinutes,
  toISODateString,
  triggerHaptic,
} from '@/core/utils/helpers';
import { determineShift, togglePause } from '@/modules/tms/services/employee';
import { buildLocationNameMap } from '@/modules/tms/services/locations';
import PullToRefresh from '@/shared/components/layout/PullToRefresh';
import Spinner from '@/shared/components/common/Spinner';
import ConfirmDialog from '@/shared/components/modals/ConfirmDialog';
import { LEAVE_REQUEST_TYPES, TMS_LIMITS } from '@/shared/constants';

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;

function formatWorkedDuration(minutes: number) {
  const safeMinutes = Math.max(0, Math.floor(minutes));
  const hours = Math.floor(safeMinutes / MINUTES_PER_HOUR);
  return `${hours}h ${safeMinutes % MINUTES_PER_HOUR}m`;
}

function monthContext(date: Date) {
  const year = date.getFullYear();
  const month = date.getMonth();
  return {
    key: `${year}-${String(month + 1).padStart(2, '0')}`,
    title: `Chỉ số tháng ${month + 1}`,
    period: `${formatDateString(new Date(year, month, 1)).slice(0, 5)} – ${formatDateString(new Date(year, month + 1, 0)).slice(0, 5)}`,
  };
}

function formatHomeDate(date: Date) {
  return new Intl.DateTimeFormat('vi-VN', {
    weekday: 'long',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(date);
}

interface Props {
  data: DashboardData | null;
  loading: boolean;
  onCheckOut: () => void;
  onScanKiosk: () => void;
  onRefresh: () => Promise<void>;
  onAlert: (title: string, msg: string, type: 'success' | 'error' | 'warning') => void;
  onExplain?: (date: string, reason: string) => void;
  explainableItems?: { date: string; explainReason: string }[];
  onNavigate?: (tab: 'history' | 'requests' | 'calendar') => void;
  onCreateRequest?: (type: string) => void;
}

const TabHome: React.FC<Props> = ({
  data,
  loading,
  onCheckOut,
  onScanKiosk,
  onRefresh,
  onAlert,
  onExplain,
  explainableItems,
  onNavigate,
  onCreateRequest,
}) => {
  const [timeStr, setTimeStr] = useState(() => getCurrentTimeStr());
  const [secondsStr, setSecondsStr] = useState(() => String(new Date().getSeconds()).padStart(2, '0'));
  const [dateStr, setDateStr] = useState(() => formatHomeDate(new Date()));
  const [isPausing, setIsPausing] = useState(false);
  const pauseInFlightRef = useRef(false);
  const [isDetailsOpen, setIsDetailsOpen] = useState(false);
  const [holidayConfirm, setHolidayConfirm] = useState<{ isOpen: boolean; name: string }>({ isOpen: false, name: '' });
  const [earlyCheckoutConfirm, setEarlyCheckoutConfirm] = useState<{ isOpen: boolean; minutes: number }>({ isOpen: false, minutes: 0 });

  useEffect(() => {
    const update = () => {
      const now = new Date();
      setTimeStr(now.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', hour12: false }));
      setSecondsStr(String(now.getSeconds()).padStart(2, '0'));
      setDateStr(formatHomeDate(now));
    };
    update();
    const timer = window.setInterval(update, TMS_LIMITS.CLOCK_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, []);

  const todaysAtt = useMemo(() => {
    const today = toISODateString(new Date());
    return data?.history.history
      .filter((item) => item.date === today)
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))[0] || null;
  }, [data?.history.history]);

  const working = Boolean(todaysAtt?.time_in && !todaysAtt.time_out);
  const checkedOut = Boolean(todaysAtt?.time_out);
  const paused = Boolean(todaysAtt?.break_start);

  const currentShift = useMemo(() => {
    // Once today's canonical timesheet exists, it is always the source of truth.
    // This prevents the UI from switching to a later configured shift after checkout.
    if (todaysAtt?.shift_name) {
      return {
        name: todaysAtt.shift_name,
        start: todaysAtt.shift_start || '00:00',
        end: todaysAtt.shift_end || '00:00',
      };
    }
    if (data?.shifts?.length) return determineShift(timeStr, data.shifts);
    return { name: '--', start: '00:00', end: '00:00' };
  }, [data?.shifts, timeStr, todaysAtt?.shift_end, todaysAtt?.shift_name, todaysAtt?.shift_start]);

  const attendanceState = paused ? 'paused' : working ? 'working' : checkedOut ? 'complete' : 'ready';
  const attendanceLabel = paused ? 'Đang tạm dừng' : working ? 'Đang làm việc' : checkedOut ? 'Đã hoàn tất hôm nay' : 'Chưa vào ca';

  const statusText = useMemo(() => {
    if (checkedOut && todaysAtt) {
      if ((todaysAtt.early_minutes || 0) > 0) return `Về sớm ${todaysAtt.early_minutes} phút`;
      if ((todaysAtt.late_minutes || 0) > 0) return `Đi trễ ${todaysAtt.late_minutes} phút`;
      return 'Hoàn thành';
    }
    if (working && todaysAtt) {
      if ((todaysAtt.late_minutes || 0) > 0) return `Đi trễ ${todaysAtt.late_minutes} phút`;
      const nowMinutes = timeToMinutes(timeStr);
      const startMinutes = timeToMinutes(currentShift.start);
      let endMinutes = timeToMinutes(currentShift.end);
      if (endMinutes < startMinutes) endMinutes += 1440;
      let adjustedNow = nowMinutes;
      if (endMinutes > 1440 && nowMinutes < startMinutes) adjustedNow += 1440;
      if (adjustedNow > endMinutes) return `Tăng ca ${adjustedNow - endMinutes} phút`;
      return 'Đúng giờ';
    }
    if (currentShift.start !== '00:00') {
      const nowMinutes = timeToMinutes(timeStr);
      const startMinutes = timeToMinutes(currentShift.start);
      if (nowMinutes < startMinutes) return 'Sẵn sàng';
      return 'Có thể chấm công';
    }
    return 'Chưa có lịch';
  }, [checkedOut, currentShift.end, currentShift.start, timeStr, todaysAtt, working]);

  const pendingExplanation = explainableItems?.[0] || null;
  const summary = data?.history.summary;
  const lateMinutes = summary?.lateMins ?? 0;
  const month = useMemo(() => monthContext(new Date()), [dateStr]);
  const monthRows = useMemo(
    () => data?.history.history.filter((item) => item.date.startsWith(month.key)) || [],
    [data?.history.history, month.key],
  );
  const lateOccurrences = useMemo(
    () => monthRows.filter((item) => Number(item.late_minutes || 0) > 0).length,
    [monthRows],
  );
  const workProgress = summary?.standardDays
    ? Math.min(100, Math.max(0, ((summary.workDays ?? 0) / summary.standardDays) * 100))
    : 0;

  const workedMinutes = useMemo(() => {
    if (!todaysAtt?.time_in) return 0;
    if (checkedOut) return Math.round(Math.max(0, Number(todaysAtt.work_hours || 0)) * MINUTES_PER_HOUR);
    const checkinMinutes = timeToMinutes(todaysAtt.time_in);
    let currentMinutes = timeToMinutes(timeStr);
    if (currentMinutes < checkinMinutes) currentMinutes += MINUTES_PER_DAY;
    return Math.max(0, currentMinutes - checkinMinutes - Number(todaysAtt.total_break_mins || 0));
  }, [checkedOut, timeStr, todaysAtt]);

  const activeCenterId = todaysAtt?.center_id || data?.userProfile?.center_id || '';
  const locationNames = useMemo(() => buildLocationNameMap(data), [data]);
  const activeLocation = useMemo(
    () => data?.locations.find((location) => location.center_id === activeCenterId) || null,
    [activeCenterId, data?.locations],
  );
  const directoryLocationName = data?.locationDirectory.find((location) => location.center_id === activeCenterId)?.center_name;
  const recordedLocationName = todaysAtt?.location_name && todaysAtt.location_name !== activeCenterId
    ? todaysAtt.location_name
    : '';
  const locationName = recordedLocationName
    || activeLocation?.location_name
    || activeLocation?.center_name
    || locationNames[activeCenterId]
    || directoryLocationName
    || locationNames[data?.userProfile?.center_id || '']
    || activeCenterId
    || 'Chưa xác định';
  const geofenceRadius = activeLocation?.radius_meters || data?.systemConfig.MAX_DISTANCE_METERS;
  const shiftHeadline = paused
    ? 'Đang tạm dừng'
    : todaysAtt?.time_out
      ? `Đã check-out lúc ${todaysAtt.time_out}`
      : todaysAtt?.time_in
        ? `Đã check-in lúc ${todaysAtt.time_in}`
        : attendanceLabel;

  const handleCheckIn = () => {
    triggerHaptic('medium');
    const today = toISODateString(new Date());
    const holiday = data?.holidays?.find((item) => today >= item.from_date && today <= item.to_date);
    if (holiday) {
      setHolidayConfirm({ isOpen: true, name: holiday.name });
      return;
    }
    onScanKiosk();
  };

  const handleCheckOut = () => {
    triggerHaptic('medium');
    const nowMinutes = timeToMinutes(getCurrentTimeStr());
    const startMinutes = timeToMinutes(currentShift.start);
    let endMinutes = timeToMinutes(currentShift.end);
    let adjustedNow = nowMinutes;
    if (endMinutes < startMinutes) {
      endMinutes += 1440;
      if (nowMinutes < startMinutes) adjustedNow += 1440;
    }
    const earlyMinutes = endMinutes - adjustedNow;
    if (earlyMinutes > TMS_LIMITS.EARLY_CHECKOUT_WARNING_MINUTES) {
      setEarlyCheckoutConfirm({ isOpen: true, minutes: earlyMinutes });
      return;
    }
    onCheckOut();
  };

  const handlePause = async () => {
    if (pauseInFlightRef.current) return;
    pauseInFlightRef.current = true;
    triggerHaptic('medium');
    setIsPausing(true);
    try {
      const result = await togglePause();
      if (!result.success) {
        onAlert('Không thể cập nhật', result.message, 'error');
        return;
      }
      await onRefresh();
      onAlert('Đã cập nhật trạng thái ca', result.message, 'success');
    } catch (error) {
      onAlert('Không thể cập nhật', error instanceof Error ? error.message : 'Vui lòng thử lại.', 'error');
    } finally {
      pauseInFlightRef.current = false;
      setIsPausing(false);
    }
  };

  const action = paused
    ? { label: 'Tiếp tục làm việc', hint: 'Chạm để tiếp tục', icon: 'play_arrow', run: handlePause, disabled: isPausing }
    : working
      ? { label: 'Check-out', hint: 'Chạm để xác nhận', icon: 'logout', run: handleCheckOut, disabled: false }
      : checkedOut
        ? { label: 'Đã hoàn tất', hint: 'Đã ghi nhận hôm nay', icon: 'task_alt', run: () => undefined, disabled: true }
        : { label: 'Chấm công', hint: 'Chạm để quét QR', icon: 'qr_code_scanner', run: handleCheckIn, disabled: false };

  if (loading && !data) {
    return (
      <div className="employee-page home-loading">
        <div className="home-loading-content">
          <Spinner size="lg" />
          <p className="app-loading-note">Đang tải trạng thái làm việc…</p>
        </div>
      </div>
    );
  }

  return (
    <>
      <PullToRefresh onRefresh={onRefresh} className="home-page page-bg">
        <div className="employee-page employee-page-home home-dashboard animate-fade-in">
          <section className="home-hero home-panel">
            <div className="home-hero-topline">
              <span className="home-date-chip">
                <span className="material-symbols-rounded" aria-hidden="true">calendar_today</span>
                {dateStr}
              </span>
              <span className={`home-shift-chip home-shift-chip-${attendanceState}`}>
                <span className="home-status-dot" aria-hidden="true" />
                {currentShift.name}
              </span>
            </div>

            <h1 className="clock-display tabular-nums">
              {timeStr}<span>:{secondsStr}</span>
            </h1>
            <p className="home-worked-pill">
              <span className="material-symbols-rounded" aria-hidden="true">schedule</span>
              Đã làm: <strong className="tabular-nums">{formatWorkedDuration(workedMinutes)}</strong> hôm nay
            </p>

            <div className="home-status">
              <button
                type="button"
                className="home-status-toggle"
                aria-expanded={isDetailsOpen}
                aria-controls="home-shift-details"
                onClick={() => {
                  triggerHaptic('light');
                  setIsDetailsOpen((value) => !value);
                }}
              >
                <span className="home-status-icon" aria-hidden="true">
                  <span className="material-symbols-rounded">{paused ? 'pause_circle' : checkedOut ? 'task_alt' : working ? 'verified_user' : 'schedule'}</span>
                </span>
                <span className="home-status-copy">
                  <strong>{shiftHeadline}</strong>
                  <small>Khung giờ quy định {currentShift.start} – {currentShift.end}</small>
                </span>
                <span className="home-status-detail-label">Chi tiết</span>
                <span className={`material-symbols-rounded home-status-chevron ${isDetailsOpen ? 'rotate-180' : ''}`} aria-hidden="true">expand_more</span>
              </button>
              <div id="home-shift-details" className={`home-status-details ${isDetailsOpen ? 'home-status-details-open' : ''}`} aria-hidden={!isDetailsOpen}>
                <dl>
                  <div><dt>Ca hôm nay</dt><dd>{currentShift.name}</dd></div>
                  <div><dt>Thời gian</dt><dd className="tabular-nums">{currentShift.start} – {currentShift.end}</dd></div>
                  {todaysAtt?.time_in ? <div><dt>Giờ vào</dt><dd className="tabular-nums">{todaysAtt.time_in}</dd></div> : null}
                  {todaysAtt?.time_out ? <div><dt>Giờ ra</dt><dd className="tabular-nums">{todaysAtt.time_out}</dd></div> : null}
                  <div><dt>Trạng thái</dt><dd>{statusText}</dd></div>
                </dl>
              </div>
            </div>

          </section>

          <section className="home-action home-panel" aria-label="Thao tác chấm công">
            <div className={`home-action-radar home-action-radar-${attendanceState}`}>
              <span className="home-action-orbit home-action-orbit-outer" aria-hidden="true" />
              <span className="home-action-orbit home-action-orbit-inner" aria-hidden="true" />
              {action.disabled ? null : (
                <>
                  <span className="home-action-ring" aria-hidden="true" />
                  <span className="home-action-ring home-action-ring-delay" aria-hidden="true" />
                </>
              )}
              <button
                type="button"
                className={`home-action-button home-action-button-${attendanceState}`}
                disabled={action.disabled}
                aria-busy={isPausing}
                onClick={() => void action.run()}
              >
                {isPausing ? <Spinner size="sm" /> : <span className="material-symbols-rounded" aria-hidden="true">{action.icon}</span>}
                <span>{action.label}</span>
                <small>{action.hint}</small>
              </button>
            </div>

            <div className="home-location-pill">
              <span className={`home-status-dot home-status-dot-${attendanceState}`} aria-hidden="true" />
              <span>{locationName}</span>
              {geofenceRadius ? <><span className="home-location-separator" aria-hidden="true">•</span><strong>Bán kính {Math.round(geofenceRadius)}m</strong></> : null}
            </div>

            <div className="home-secondary-actions">
              {working ? (
                <button type="button" className={`home-pause-button ${paused ? 'home-pause-button-active' : ''}`} disabled={isPausing} onClick={() => void handlePause()}>
                  <span className="material-symbols-rounded" aria-hidden="true">{paused ? 'play_arrow' : 'pause_circle'}</span>
                  {paused ? 'Tiếp tục làm việc' : 'Nghỉ giữa ca (Break)'}
                </button>
              ) : <span />}
              <button type="button" className="home-history-button" onClick={() => onNavigate?.('history')}>
                <span className="material-symbols-rounded" aria-hidden="true">history</span>
                Lịch sử hôm nay
              </button>
            </div>
          </section>

          {pendingExplanation && onExplain ? (
            <section className="home-prompt animate-slide-up" aria-label="Cần giải trình">
              <span className="home-prompt-icon" aria-hidden="true"><span className="material-symbols-rounded">warning_amber</span></span>
              <span className="home-prompt-text">
                <span className="home-prompt-meta"><strong>Cần giải trình</strong><span aria-hidden="true">•</span>{formatDateString(pendingExplanation.date).slice(0, 5)}</span>
                <span className="home-prompt-title">{pendingExplanation.explainReason}</span>
                <span className="home-prompt-reason">Ca {currentShift.start} – {currentShift.end} · Thiếu dữ liệu chấm công</span>
              </span>
              <button
                type="button"
                className="home-prompt-action"
                onClick={() => {
                  triggerHaptic('light');
                  onExplain(pendingExplanation.date, pendingExplanation.explainReason);
                }}
              >
                Xử lý
              </button>
            </section>
          ) : null}

          <section className="home-metrics-section">
            <div className="home-section-heading">
              <span><strong>{month.title}</strong><i aria-hidden="true" /></span>
              <small className="tabular-nums">{month.period}</small>
            </div>

            <div className="home-metrics ui-metrics ui-metrics-half animate-slide-up">
              <div className="ui-metric home-metric-standard">
                <span className="ui-metric-head">
                  <span>Công chuẩn</span>
                  <span className="home-metric-icon material-symbols-rounded" aria-hidden="true">event_available</span>
                </span>
                <span className="ui-metric-value">
                  {summary?.standardDays ?? 0}
                  <span className="ui-metric-unit">ngày</span>
                </span>
                <progress className="ui-progress" value={summary?.standardDays ?? 0} max={summary?.standardDays || 1} aria-label={`${summary?.standardDays ?? 0} ngày công chuẩn`} />
              </div>

              <div className="ui-metric home-metric-worked">
                <span className="ui-metric-head">
                  <span>Công thực tế</span>
                  <span className="home-metric-icon material-symbols-rounded" aria-hidden="true">done_all</span>
                </span>
                <span className="ui-metric-value">
                  {summary?.workDays ?? 0}
                  <span className="ui-metric-unit">ngày</span>
                </span>
                <progress
                  className="ui-progress"
                  value={summary?.workDays ?? 0}
                  max={summary?.standardDays || 1}
                  aria-label={`Đã đạt ${summary?.workDays ?? 0} trên ${summary?.standardDays ?? 0} ngày công`}
                >
                  {workProgress}%
                </progress>
              </div>

              <div className="ui-metric home-metric-leave">
                <span className="ui-metric-head">
                  <span>Phép đã dùng</span>
                  <span className="home-metric-icon material-symbols-rounded" aria-hidden="true">beach_access</span>
                </span>
                <span className="ui-metric-value">
                  {summary?.leaveDays ?? 0}
                  <span className="ui-metric-unit">ngày</span>
                </span>
                <span className="ui-metric-foot"><span>Khả dụng</span><strong>{summary?.remainingLeave ?? 0} ngày</strong></span>
              </div>

              <div className={`ui-metric home-metric-late ${lateMinutes > 0 ? 'ui-metric-attention' : ''}`.trim()}>
                <span className="ui-metric-head">
                  <span>Đi trễ</span>
                  <span className={`home-metric-icon material-symbols-rounded ${lateMinutes > 0 ? 'ui-tone-danger' : 'ui-tone-muted'}`} aria-hidden="true">timer_off</span>
                </span>
                <span className={`ui-metric-value ${lateMinutes > 0 ? 'ui-tone-danger' : ''}`.trim()}>
                  {lateMinutes}
                  <span className="ui-metric-unit">phút</span>
                </span>
                <span className="ui-metric-foot"><span>Tần suất</span><strong>{lateOccurrences} lần</strong></span>
              </div>
            </div>
          </section>

          <section className="home-shortcuts" aria-label="Thao tác nhanh">
            <button type="button" onClick={() => onCreateRequest?.(LEAVE_REQUEST_TYPES[0])}>
              <span className="home-shortcut-icon material-symbols-rounded" aria-hidden="true">event_busy</span>
              <span>Xin nghỉ</span>
            </button>
            <button type="button" onClick={() => onNavigate?.('requests')}>
              <span className="home-shortcut-icon material-symbols-rounded" aria-hidden="true">description</span>
              <span>Đề xuất</span>
            </button>
            <button type="button" onClick={() => onNavigate?.('calendar')}>
              <span className="home-shortcut-icon material-symbols-rounded" aria-hidden="true">calendar_month</span>
              <span>Lịch làm việc</span>
            </button>
          </section>
        </div>
      </PullToRefresh>

      <ConfirmDialog
        isOpen={holidayConfirm.isOpen}
        title="Hôm nay là ngày lễ"
        message={<>Hệ thống ghi nhận <strong>{holidayConfirm.name}</strong> là ngày nghỉ. Chỉ tiếp tục nếu anh/chị thực sự đang làm việc.</>}
        confirmLabel="Vẫn chấm công"
        onConfirm={() => { setHolidayConfirm({ isOpen: false, name: '' }); onScanKiosk(); }}
        onCancel={() => setHolidayConfirm({ isOpen: false, name: '' })}
        type="warning"
      />

      <ConfirmDialog
        isOpen={earlyCheckoutConfirm.isOpen}
        title="Check-out sớm?"
        message={<>Còn <strong>{earlyCheckoutConfirm.minutes} phút</strong> nữa mới hết ca. Nếu tiếp tục, hệ thống sẽ ghi nhận về sớm.</>}
        confirmLabel="Vẫn check-out"
        onConfirm={() => { setEarlyCheckoutConfirm({ isOpen: false, minutes: 0 }); onCheckOut(); }}
        onCancel={() => setEarlyCheckoutConfirm({ isOpen: false, minutes: 0 })}
        type="danger"
      />
    </>
  );
};

export default TabHome;
