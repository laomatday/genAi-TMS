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
import StatCard from '@/shared/components/data/StatCard';
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

  const workProgress = useMemo(() => {
    if (!working || !todaysAtt?.time_in || currentShift.start === '00:00' || currentShift.end === '00:00') return null;
    const inMinutes = timeToMinutes(todaysAtt.time_in);
    let nowMinutes = timeToMinutes(timeStr);
    const startMinutes = timeToMinutes(currentShift.start);
    let endMinutes = timeToMinutes(currentShift.end);
    if (endMinutes < startMinutes) {
      endMinutes += 1440;
      if (nowMinutes < startMinutes) nowMinutes += 1440;
    }
    const elapsed = Math.max(0, nowMinutes - inMinutes);
    const duration = Math.max(60, endMinutes - startMinutes);
    return {
      percent: Math.min(100, Math.round((elapsed / duration) * 100)),
      workedHours: (elapsed / 60).toFixed(1),
      targetHours: (duration / 60).toFixed(1),
    };
  }, [currentShift.end, currentShift.start, timeStr, todaysAtt?.time_in, working]);

  const pendingExplanation = explainableItems?.[0] || null;
  const summary = data?.history.summary;

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
          <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">Đang tải trạng thái làm việc…</p>
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

            {workProgress ? (
              <div className="home-work-progress-card animate-fade-in">
                <div className="mb-1.5 flex items-center justify-between text-xs font-semibold">
                  <span className="flex items-center gap-1.5 text-slate-700 dark:text-slate-200">
                    <span className="size-2 animate-pulse rounded-full bg-emerald-500" />
                    Tiến độ ca
                  </span>
                  <span className="tabular-nums font-bold text-primary">{workProgress.workedHours}h / {workProgress.targetHours}h</span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200/80 dark:bg-slate-700/60">
                  <div className="h-full rounded-full bg-primary transition-all duration-500" style={{ width: `${workProgress.percent}%` }} />
                </div>
              </div>
            ) : null}
          </section>

          <section className="home-action" aria-label="Thao tác chấm công">
            <button
              type="button"
              className="home-action-button"
              disabled={action.disabled}
              onClick={() => void action.run()}
            >
              {isPausing ? <Spinner size="sm" /> : <span className="material-symbols-rounded" aria-hidden="true">{action.icon}</span>}
              <span>{action.label}</span>
            </button>
            {working && !paused ? (
              <button type="button" className="home-pause-button" disabled={isPausing} onClick={() => void handlePause()}>
                <span className="material-symbols-rounded" aria-hidden="true">pause</span>
                Tạm dừng
              </button>
            ) : null}
            <p className="mt-3 text-center text-xs text-slate-500 dark:text-slate-400">
              {checkedOut ? 'Ngày công đã được ghi nhận. Không cần thao tác thêm.' : 'Vị trí và quyền thiết bị được hệ thống kiểm tra trước khi ghi nhận.'}
            </p>
          </section>

          {pendingExplanation && onExplain ? (
            <section className="home-smart-prompt animate-slide-up" aria-label="Cần giải trình">
              <div className="home-smart-prompt-content">
                <span className="material-symbols-rounded home-smart-prompt-icon" aria-hidden="true">notification_important</span>
                <div className="home-smart-prompt-text">
                  <strong>Cần giải trình · {formatDateString(pendingExplanation.date)}</strong>
                  <p>{pendingExplanation.explainReason}</p>
                </div>
              </div>
              <button
                type="button"
                className="home-smart-prompt-action"
                onClick={() => {
                  triggerHaptic('light');
                  onExplain(pendingExplanation.date, pendingExplanation.explainReason);
                }}
              >
                Xử lý
              </button>
            </section>
          ) : null}

          <div className="home-stats-header">
            <div>
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">Tháng hiện tại</span>
              <h3 className="mt-1 text-lg font-bold text-slate-900 dark:text-white">Tổng quan công</h3>
            </div>
          </div>

          <div className="home-stats-grid animate-slide-up">
            <StatCard title="Công chuẩn" value={summary?.standardDays ?? 0} sub={<span className="stat-label-bottom">ngày</span>} icon="calendar_today" color="blue" />
            <StatCard title="Công thực tế" value={summary?.workDays ?? 0} sub={<span className="stat-label-bottom">ngày</span>} icon="check_circle" color="indigo" />
            <StatCard title="Phép đã dùng" value={summary?.leaveDays ?? 0} sub={<span className="stat-label-bottom">còn {summary?.remainingLeave ?? 0}</span>} icon="beach_access" color="amber" />
            <StatCard title="Đi trễ" value={summary?.lateMins ?? 0} sub={<span className="stat-label-bottom">phút</span>} icon="schedule" color="rose" />
          </div>
        </div>
      </PullToRefresh>

      {holidayConfirm.isOpen ? (
        <div className="app-dialog-backdrop animate-fade-in">
          <div className="app-dialog animate-scale-in" role="alertdialog" aria-modal="true" aria-labelledby="holiday-dialog-title">
            <span className="app-dialog-icon status-tone-danger material-symbols-rounded" aria-hidden="true">celebration</span>
            <h3 id="holiday-dialog-title">Hôm nay là ngày lễ</h3>
            <strong className="status-tone-danger">{holidayConfirm.name}</strong>
            <p>Hệ thống đang ghi nhận hôm nay là ngày nghỉ. Chỉ tiếp tục nếu anh/chị thực sự đang làm việc.</p>
            <div className="app-dialog-actions">
              <button type="button" className="btn btn-primary btn-md" onClick={() => { setHolidayConfirm({ isOpen: false, name: '' }); onScanKiosk(); }}>
                <span className="material-symbols-rounded" aria-hidden="true">work</span>Vẫn chấm công
              </button>
              <button type="button" className="btn btn-secondary btn-md" onClick={() => setHolidayConfirm({ isOpen: false, name: '' })}>Hủy</button>
            </div>
          </div>
        </div>
      ) : null}

      {earlyCheckoutConfirm.isOpen ? (
        <div className="app-dialog-backdrop animate-fade-in">
          <div className="app-dialog animate-scale-in" role="alertdialog" aria-modal="true" aria-labelledby="early-dialog-title">
            <span className="app-dialog-icon status-tone-warning material-symbols-rounded" aria-hidden="true">timer</span>
            <h3 id="early-dialog-title">Check-out sớm?</h3>
            <strong className="status-tone-warning">Sớm {earlyCheckoutConfirm.minutes} phút</strong>
            <p>Nếu tiếp tục, hệ thống sẽ ghi nhận về sớm theo ca đã được phân.</p>
            <div className="app-dialog-actions">
              <button type="button" className="btn btn-danger btn-md" onClick={() => { setEarlyCheckoutConfirm({ isOpen: false, minutes: 0 }); onCheckOut(); }}>
                <span className="material-symbols-rounded" aria-hidden="true">logout</span>Vẫn Check-out
              </button>
              <button type="button" className="btn btn-secondary btn-md" onClick={() => setEarlyCheckoutConfirm({ isOpen: false, minutes: 0 })}>Hủy</button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
};

export default TabHome;
