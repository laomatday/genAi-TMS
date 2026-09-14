import React, { useEffect, useMemo, useState } from 'react';
import type { DashboardData } from '@/shared/types';
import {
  formatDateString,
  formatVietnameseDayHeader,
  getCurrentTimeStr,
  timeToMinutes,
  toISODateString,
  triggerHaptic,
} from '@/core/utils/helpers';
import { determineShift, togglePause } from '@/modules/tms/services/employee';
import PullToRefresh from '@/shared/components/layout/PullToRefresh';
import Spinner from '@/shared/components/common/Spinner';
import ConfirmDialog from '@/shared/components/modals/ConfirmDialog';
import { TMS_LIMITS } from '@/shared/constants';

interface Props {
  data: DashboardData | null;
  loading: boolean;
  onCheckOut: () => void;
  onScanKiosk: () => void;
  onRefresh: () => Promise<void>;
  onAlert: (title: string, msg: string, type: 'success' | 'error' | 'warning') => void;
  onExplain?: (date: string, reason: string) => void;
  explainableItems?: { date: string; explainReason: string }[];
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
}) => {
  const [timeStr, setTimeStr] = useState(() => getCurrentTimeStr());
  const [dateStr, setDateStr] = useState(() => formatVietnameseDayHeader(new Date()));
  const [isPausing, setIsPausing] = useState(false);
  const [isDetailsOpen, setIsDetailsOpen] = useState(false);
  const [holidayConfirm, setHolidayConfirm] = useState<{ isOpen: boolean; name: string }>({ isOpen: false, name: '' });
  const [earlyCheckoutConfirm, setEarlyCheckoutConfirm] = useState<{ isOpen: boolean; minutes: number }>({ isOpen: false, minutes: 0 });

  useEffect(() => {
    const update = () => {
      const now = new Date();
      setTimeStr(now.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', hour12: false }));
      setDateStr(formatVietnameseDayHeader(now));
    };
    update();
    const timer = window.setInterval(update, TMS_LIMITS.CLOCK_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, []);

  const greeting = useMemo(() => {
    const hour = new Date().getHours();
    if (hour < 12) return 'Chào buổi sáng';
    if (hour < 18) return 'Chào buổi chiều';
    return 'Chào buổi tối';
  }, [timeStr]);

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
  const workProgress = summary?.standardDays
    ? Math.min(100, Math.max(0, ((summary.workDays ?? 0) / summary.standardDays) * 100))
    : 0;

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
    if (isPausing) return;
    triggerHaptic('medium');
    setIsPausing(true);
    const result = await togglePause();
    if (result.success) await onRefresh();
    else onAlert('Không thể cập nhật', result.message, 'error');
    setIsPausing(false);
  };

  const action = paused
    ? { label: 'Tiếp tục làm việc', icon: 'play_arrow', run: handlePause, disabled: isPausing }
    : working
      ? { label: 'Check-out', icon: 'logout', run: handleCheckOut, disabled: false }
      : checkedOut
        ? { label: 'Đã hoàn tất hôm nay', icon: 'task_alt', run: () => undefined, disabled: true }
        : { label: 'Quét QR chấm công', icon: 'qr_code_scanner', run: handleCheckIn, disabled: false };

  if (loading && !data) {
    return (
      <div className="employee-page flex min-h-[60vh] items-center justify-center">
        <div className="text-center">
          <Spinner size="lg" />
          <p className="app-loading-note">Đang tải trạng thái làm việc…</p>
        </div>
      </div>
    );
  }

  return (
    <>
      <PullToRefresh onRefresh={onRefresh} className="home-page page-bg transition-colors duration-300">
        <div className="employee-page employee-page-home home-dashboard animate-fade-in">
          <section className="home-hero">
            <div className="home-greeting">
              <span>{greeting}</span>
              <h2>{data?.userProfile?.name?.split(' ').pop() || ''}!</h2>
            </div>
            <h1 className="clock-display tabular-nums">{timeStr}</h1>
            <p className="home-date">{dateStr}</p>

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
                <span className={`home-status-dot home-status-dot-${attendanceState}`} aria-hidden="true" />
                <span>{attendanceLabel}</span>
                <span className={`material-symbols-rounded ${isDetailsOpen ? 'rotate-180' : ''}`} aria-hidden="true">expand_more</span>
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

          <section className="home-action" aria-label="Thao tác chấm công">
            <div className={`home-action-radar home-action-radar-${attendanceState}`}>
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
                onClick={() => void action.run()}
              >
                {isPausing ? <Spinner size="sm" /> : <span className="material-symbols-rounded" aria-hidden="true">{action.icon}</span>}
                <span>{action.label}</span>
              </button>
            </div>
            {working && !paused ? (
              <button type="button" className="home-pause-button" disabled={isPausing} onClick={() => void handlePause()}>
                <span className="material-symbols-rounded" aria-hidden="true">pause</span>
                Tạm dừng
              </button>
            ) : null}
          </section>

          {/* Month to date ------------------------------------------ */}
          <div>
            <div className="ui-label-row">
              <span className="ui-label">Tháng này</span>
              <span className="ui-label">Cập nhật liên tục</span>
            </div>

            <div className="ui-metrics ui-metrics-half animate-slide-up">
              <div className="ui-metric">
                <span className="ui-metric-head">
                  <span>Công chuẩn</span>
                  <span className="material-symbols-rounded ui-tone-primary" aria-hidden="true">calendar_today</span>
                </span>
                <span className="ui-metric-value">
                  {summary?.standardDays ?? 0}
                  <span className="ui-metric-unit">ngày</span>
                </span>
                <span className="ui-metric-foot">Định mức kỳ công</span>
              </div>

              <div className="ui-metric">
                <span className="ui-metric-head">
                  <span>Công thực tế</span>
                  <span className="material-symbols-rounded ui-tone-success" aria-hidden="true">task_alt</span>
                </span>
                <span className="ui-metric-value ui-tone-success">
                  {summary?.workDays ?? 0}
                  <span className="ui-metric-unit">ngày</span>
                </span>
                <span className="ui-progress" role="img" aria-label={`Đã đạt ${summary?.workDays ?? 0} trên ${summary?.standardDays ?? 0} ngày công`}>
                  <span style={{ width: `${workProgress}%` }} />
                </span>
              </div>

              <div className="ui-metric">
                <span className="ui-metric-head">
                  <span>Phép đã dùng</span>
                  <span className="material-symbols-rounded ui-tone-info" aria-hidden="true">beach_access</span>
                </span>
                <span className="ui-metric-value ui-tone-info">
                  {summary?.leaveDays ?? 0}
                  <span className="ui-metric-unit">ngày</span>
                </span>
                <span className="ui-metric-foot">Còn {summary?.remainingLeave ?? 0} ngày</span>
              </div>

              <div className={`ui-metric ${lateMinutes > 0 ? 'ui-metric-attention' : ''}`.trim()}>
                <span className="ui-metric-head">
                  <span>Đi trễ</span>
                  <span className={`material-symbols-rounded ${lateMinutes > 0 ? 'ui-tone-danger' : 'ui-tone-muted'}`} aria-hidden="true">schedule</span>
                </span>
                <span className={`ui-metric-value ${lateMinutes > 0 ? 'ui-tone-danger' : ''}`.trim()}>
                  {lateMinutes}
                  <span className="ui-metric-unit">phút</span>
                </span>
                <span className="ui-metric-foot">{lateMinutes > 0 ? 'Có vi phạm giờ vào' : 'Không vi phạm'}</span>
              </div>
            </div>
          </div>

          {/* Something needs you ------------------------------------- */}
          {pendingExplanation && onExplain ? (
            <section className="ui-card ui-card-attention ui-card-pad animate-slide-up home-prompt" aria-label="Cần giải trình">
              <div className="home-prompt-head">
                <span className="ui-tile ui-tile-soft ui-tone-danger" aria-hidden="true">
                  <span className="material-symbols-rounded">notification_important</span>
                </span>
                <span className="home-prompt-text">
                  <span className="home-prompt-title">Cần giải trình · {formatDateString(pendingExplanation.date)}</span>
                  <span className="home-prompt-reason">{pendingExplanation.explainReason}</span>
                </span>
              </div>
              <button
                type="button"
                className="ui-cta"
                onClick={() => {
                  triggerHaptic('light');
                  onExplain(pendingExplanation.date, pendingExplanation.explainReason);
                }}
              >
                <span className="material-symbols-rounded" aria-hidden="true">edit_document</span>
                Giải trình ngay
              </button>
            </section>
          ) : null}
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
