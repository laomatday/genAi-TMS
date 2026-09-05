import React, { useState, useEffect, useMemo } from 'react';
import { DashboardData } from '@/shared/types';
import { triggerHaptic, timeToMinutes, getCurrentTimeStr, toISODateString, formatVietnameseDayHeader, formatDateString } from '@/core/utils/helpers';
import { togglePause, determineShift } from '@/modules/tms/services/employee';
import PullToRefresh from '@/shared/components/layout/PullToRefresh';
import Spinner from '@/shared/components/common/Spinner';
import StatCard from '@/shared/components/data/StatCard';
import { TMS_DEFAULT_SYSTEM_CONFIG, TMS_DEFAULTS, TMS_LIMITS } from '@/shared/constants';

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

const TabHome: React.FC<Props> = ({ data, loading, onCheckOut, onScanKiosk, onRefresh, onAlert, onExplain, explainableItems }) => {
    const [timeStr, setTimeStr] = useState(() => new Date().toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit", hour12: false }));
    const [dateStr, setDateStr] = useState(() => formatVietnameseDayHeader(new Date()));
    const [isPausing, setIsPausing] = useState(false);
    const [isDetailsOpen, setIsDetailsOpen] = useState(false);
    const [viewDate, setViewDate] = useState<Date>(new Date());
    const greeting = useMemo(() => { const hour = new Date().getHours(); if (hour < 12) return "Chào buổi sáng"; if (hour < 18) return "Chào buổi chiều"; return "Chào buổi tối"; }, [timeStr]);
    const [holidayConfirm, setHolidayConfirm] = useState<{ isOpen: boolean, name: string }>({ isOpen: false, name: '' });
    const [earlyCheckoutConfirm, setEarlyCheckoutConfirm] = useState<{ isOpen: boolean, minutes: number }>({ isOpen: false, minutes: 0 });

    useEffect(() => {
        const update = () => {
            const d = new Date();
            setTimeStr(d.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit", hour12: false }));
            setDateStr(formatVietnameseDayHeader(d));
        };
        update(); const i = setInterval(update, TMS_LIMITS.CLOCK_REFRESH_MS); return () => clearInterval(i);
    }, []);

    const getTodaysAttendance = () => {
        if (!data || !data.history.history.length) return null;
        const todayStr = toISODateString(new Date());
        return data.history.history.filter(h => h.date === todayStr).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))[0] || null;
    };
    const todaysAtt = getTodaysAttendance();
    const working = !!(todaysAtt && !todaysAtt.time_out);
    const checkedOut = !!(todaysAtt && todaysAtt.time_out);
    const paused = !!todaysAtt?.break_start;

    const currentShift = useMemo(() => {
        if (working && todaysAtt?.shift_name) return { name: todaysAtt.shift_name, start: todaysAtt.shift_start || "00:00", end: todaysAtt.shift_end || "00:00" };
        if (data?.shifts) return determineShift(getCurrentTimeStr(), data.shifts);
        return { name: "--", start: "00:00", end: "00:00" };
    }, [working, todaysAtt, data?.shifts, timeStr]);

    const dayIsOver = useMemo(() => {
        if (!checkedOut || !todaysAtt) return false;
        if (currentShift.name !== '--' && currentShift.name !== todaysAtt.shift_name) return false;
        return true;
    }, [checkedOut, todaysAtt, currentShift]);

    const realTimeStatus = useMemo(() => {
        const nowMins = timeToMinutes(timeStr);
        const startMins = timeToMinutes(currentShift.start);
        let endMins = timeToMinutes(currentShift.end);
        const isOvernight = endMins < startMins;
        if (isOvernight) endMins += 24 * 60;
        let displayNowMins = nowMins;
        if (isOvernight && nowMins < startMins && nowMins < startMins - 720) displayNowMins += 24 * 60;
        const tolerance = data?.systemConfig?.LATE_TOLERANCE ?? TMS_DEFAULT_SYSTEM_CONFIG.LATE_TOLERANCE;
        if (working && todaysAtt) {
            if (todaysAtt.late_minutes && todaysAtt.late_minutes > 0) return { text: `Đi trễ ${todaysAtt.late_minutes}p`, tone: 'warning', shiftName: currentShift.name };
            if (displayNowMins > endMins) return { text: `Tăng ca ${Math.floor(displayNowMins - endMins)}p`, tone: 'primary', shiftName: currentShift.name };
            return { text: 'Đúng giờ', tone: 'primary', shiftName: currentShift.name };
        }
        if (!dayIsOver) {
            if (nowMins > startMins + tolerance) return { text: `Đang trễ ${nowMins - startMins}p`, tone: 'danger', shiftName: currentShift.name };
            if (nowMins < startMins - tolerance) return { text: 'Sẵn sàng', tone: 'primary', shiftName: currentShift.name };
            return { text: 'Vào ca ngay', tone: 'primary', shiftName: currentShift.name };
        }
        if (dayIsOver && todaysAtt) {
            if (todaysAtt.late_minutes && todaysAtt.late_minutes > 0) return { text: `Đi trễ ${todaysAtt.late_minutes}p`, tone: 'warning', shiftName: todaysAtt.shift_name };
            const earlyMinutes = timeToMinutes(todaysAtt.shift_end || '00:00') - timeToMinutes(todaysAtt.time_out || '00:00');
            if (earlyMinutes > TMS_LIMITS.EARLY_CHECKOUT_WARNING_MINUTES) return { text: `Về sớm ${earlyMinutes}p`, tone: 'warning', shiftName: todaysAtt.shift_name };
            return { text: 'Hoàn thành', tone: 'primary', shiftName: todaysAtt.shift_name };
        }
        return { text: 'Ngoài giờ', tone: 'muted', shiftName: '--' };
    }, [working, dayIsOver, todaysAtt, timeStr, currentShift, data?.systemConfig]);

    const handleCheckInClick = () => {
        triggerHaptic('medium');
        if (!data) { onScanKiosk(); return; }
        const todayStr = toISODateString(new Date());
        const holiday = data.holidays?.find(h => todayStr >= h.from_date && todayStr <= h.to_date);
        if (holiday) setHolidayConfirm({ isOpen: true, name: holiday.name }); else onScanKiosk();
    };
    const handleCheckOutClick = () => {
        triggerHaptic('medium');
        const nowMins = timeToMinutes(getCurrentTimeStr()); let endMins = timeToMinutes(currentShift.end); const startMins = timeToMinutes(currentShift.start);
        if (endMins < startMins && nowMins < startMins) endMins += 24 * 60;
        const earlyMinutes = endMins - nowMins;
        if (earlyMinutes > TMS_LIMITS.EARLY_CHECKOUT_WARNING_MINUTES) setEarlyCheckoutConfirm({ isOpen: true, minutes: earlyMinutes }); else onCheckOut();
    };
    const handlePauseToggle = async () => {
        if (!data?.userProfile) return;
        triggerHaptic('medium'); setIsPausing(true);
        const res = await togglePause();
        if (res.success) await onRefresh(); else onAlert("Lỗi", res.message, 'error');
        setIsPausing(false);
    };
    const confirmHolidayWork = () => { setHolidayConfirm({ isOpen: false, name: '' }); onScanKiosk(); };
    const confirmEarlyCheckout = () => { setEarlyCheckoutConfirm({ isOpen: false, minutes: 0 }); onCheckOut(); };

    const stats = useMemo(() => {
        const selectedMonth = viewDate.getMonth() + 1; const selectedYear = viewDate.getFullYear(); const res: { standardDays: number; workDays: number; holidayDays: number; usedLeave: number; totalLeave: number } = { standardDays: TMS_DEFAULTS.STANDARD_WORK_DAYS_PER_MONTH, workDays: 0, holidayDays: 0, usedLeave: 0, totalLeave: TMS_DEFAULTS.ANNUAL_LEAVE_DAYS };
        if (!data) return res;
        const daysInMonth = new Date(selectedYear, selectedMonth, 0).getDate(); const offDays = data.systemConfig?.OFF_DAYS ?? TMS_DEFAULT_SYSTEM_CONFIG.OFF_DAYS; let stdDays = 0;
        for (let d = 1; d <= daysInMonth; d++) if (!offDays.includes(new Date(selectedYear, selectedMonth - 1, d).getDay())) stdDays++;
        res.standardDays = stdDays;
        const validHolidays = data.holidays || []; const validLeaves = (data.myRequests || []).filter(r => r.status === 'Approved'); const validExplanations = (data.myExplanations || []).filter(e => e.status === 'Approved'); const attendanceList = data.history.history || [];
        let actualWork = 0, holidayCount = 0, specificLeaveCount = 0;
        for (let d = 1; d <= daysInMonth; d++) {
            const currentJsDate = new Date(selectedYear, selectedMonth - 1, d); const dateStr = toISODateString(currentJsDate); const dayOfWeek = currentJsDate.getDay(); let dayWorkCredit = 0;
            const att = attendanceList.find(a => a.date === dateStr);
            if (att) { const hours = att.work_hours || 0; const minFull = data.systemConfig?.MIN_HOURS_FULL ?? TMS_DEFAULT_SYSTEM_CONFIG.MIN_HOURS_FULL; const minHalf = data.systemConfig?.MIN_HOURS_HALF ?? TMS_DEFAULT_SYSTEM_CONFIG.MIN_HOURS_HALF; if (hours >= minFull) dayWorkCredit = 1; else if (hours >= minHalf) dayWorkCredit = 0.5; }
            if (validExplanations.find(e => e.date === dateStr)) dayWorkCredit = 1;
            const request = validLeaves.find(l => dateStr >= l.from_date && dateStr <= l.to_date);
            if (request) { const type = request.type.toLowerCase(); if (type.includes('công tác') || type.includes('làm việc tại nhà')) dayWorkCredit = 1; if (type.includes('nghỉ phép') || type.includes('nghỉ ốm')) specificLeaveCount++; }
            actualWork += dayWorkCredit;
            const holiday = validHolidays.find(h => dateStr >= h.from_date && dateStr <= h.to_date); if (holiday && !offDays.includes(dayOfWeek)) holidayCount++;
        }
        res.workDays = actualWork; res.holidayDays = holidayCount; res.usedLeave = specificLeaveCount; res.totalLeave = data.userProfile?.annual_leave_balance ?? TMS_DEFAULTS.ANNUAL_LEAVE_DAYS; return res;
    }, [data, viewDate]);

    const isNextMonthDisabled = useMemo(() => { const today = new Date(); return viewDate.getMonth() === today.getMonth() && viewDate.getFullYear() === today.getFullYear(); }, [viewDate]);
    const changeMonth = (delta: number) => { const newDate = new Date(viewDate); newDate.setMonth(newDate.getMonth() + delta); if (newDate > new Date()) { triggerHaptic('error'); return; } triggerHaptic('light'); setViewDate(newDate); };
    const attendanceState = paused ? 'paused' : working ? 'working' : dayIsOver ? 'complete' : 'ready';
    const attendanceLabel = paused ? 'Đang tạm dừng' : working ? 'Đang làm việc' : dayIsOver ? 'Đã check-out' : 'Chưa vào ca';
    const actionLabel = paused ? 'Tiếp tục' : working ? 'Ra về' : dayIsOver ? 'Đã về' : 'Chấm công';
    const actionIcon = paused ? 'play_arrow' : working ? 'directions_run' : dayIsOver ? 'home' : 'qr_code_scanner';
    const runAttendanceAction = paused ? handlePauseToggle : working ? handleCheckOutClick : handleCheckInClick;

    const pendingExplanation = useMemo(() => {
        if (!explainableItems || !explainableItems.length) return null;
        return explainableItems[0];
    }, [explainableItems]);

    const workProgress = useMemo(() => {
        if (!working || !todaysAtt?.time_in) return null;
        const inMins = timeToMinutes(todaysAtt.time_in);
        const currentMins = timeToMinutes(timeStr);
        const elapsed = Math.max(0, currentMins - inMins);
        let shiftDuration = 8 * 60;
        if (currentShift.start !== '00:00' && currentShift.end !== '00:00') {
            let endM = timeToMinutes(currentShift.end);
            const startM = timeToMinutes(currentShift.start);
            if (endM < startM) endM += 24 * 60;
            shiftDuration = Math.max(60, endM - startM);
        }
        const percent = Math.min(100, Math.max(0, Math.round((elapsed / shiftDuration) * 100)));
        return {
            workedHours: (elapsed / 60).toFixed(1),
            targetHours: (shiftDuration / 60).toFixed(1),
            percent,
        };
    }, [working, todaysAtt?.time_in, timeStr, currentShift]);

    return <>
        <PullToRefresh onRefresh={onRefresh} className="home-page transition-colors duration-1000 page-bg">
            <div className="employee-page employee-page-home home-dashboard animate-fade-in">
                <div className="home-hero">
                    <div className="home-greeting"><span>{greeting}</span><h2>{data?.userProfile?.name?.split(' ').pop()}!</h2></div>
                    <h1 className="clock-display tabular-nums">{timeStr}</h1>
                    <p className="home-date">{dateStr}</p>
                    <div className="home-status">
                        <button onClick={() => { triggerHaptic('light'); setIsDetailsOpen(!isDetailsOpen); }} className="home-status-toggle" type="button" aria-expanded={isDetailsOpen} aria-controls="home-shift-details">
                            <span className={`home-status-dot home-status-dot-${attendanceState}`} aria-hidden="true" />
                            <span>{attendanceLabel}</span>
                            <span className={`material-symbols-rounded ${isDetailsOpen ? 'rotate-180' : ''}`} aria-hidden="true">expand_more</span>
                        </button>
                        <div id="home-shift-details" className={`home-status-details ${isDetailsOpen ? 'home-status-details-open' : ''}`} aria-hidden={!isDetailsOpen}>
                            <dl>
                                <div><dt>Ca làm việc</dt><dd>{realTimeStatus.shiftName}</dd></div>
                                <div><dt>Thời gian</dt><dd className="tabular-nums">{currentShift.start} – {currentShift.end}</dd></div>
                                {(working || checkedOut) ? <div><dt>Giờ vào</dt><dd className="tabular-nums">{todaysAtt?.time_in}</dd></div> : null}
                                {checkedOut ? <div><dt>Giờ ra</dt><dd className="tabular-nums">{todaysAtt?.time_out}</dd></div> : null}
                                <div><dt>Trạng thái</dt><dd className={`status-tone-${realTimeStatus.tone}`}>{realTimeStatus.text}</dd></div>
                            </dl>
                        </div>
                    </div>

                    {working && workProgress ? (
                        <div className="home-work-progress-card animate-fade-in">
                            <div className="flex items-center justify-between text-xs font-semibold mb-1.5">
                                <span className="flex items-center gap-1.5 text-slate-700 dark:text-slate-200">
                                    <span className="size-2 rounded-full bg-emerald-500 animate-pulse" />
                                    Tiến độ ca làm việc
                                </span>
                                <span className="tabular-nums text-primary font-bold">{workProgress.workedHours}h / {workProgress.targetHours}h ({workProgress.percent}%)</span>
                            </div>
                            <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200/80 dark:bg-slate-700/60">
                                <div
                                    className="h-full rounded-full bg-gradient-to-r from-sky-500 to-indigo-600 transition-all duration-500"
                                    style={{ width: `${Math.min(workProgress.percent, 100)}%` }}
                                />
                            </div>
                        </div>
                    ) : null}

                    {pendingExplanation ? (
                        <div className="home-smart-prompt animate-slide-up" role="region" aria-label="Gợi ý giải trình">
                            <div className="home-smart-prompt-content">
                                <span className="material-symbols-rounded home-smart-prompt-icon" aria-hidden="true">notification_important</span>
                                <div className="home-smart-prompt-text">
                                    <strong>Cần giải trình: {formatDateString(pendingExplanation.date)}</strong>
                                    <p>{pendingExplanation.explainReason}</p>
                                </div>
                            </div>
                            {onExplain ? (
                                <button
                                    type="button"
                                    className="home-smart-prompt-action"
                                    onClick={() => {
                                        triggerHaptic('light');
                                        onExplain(pendingExplanation.date, pendingExplanation.explainReason);
                                    }}
                                >
                                    <span>Tạo đơn</span>
                                    <span className="material-symbols-rounded" aria-hidden="true">arrow_forward</span>
                                </button>
                            ) : null}
                        </div>
                    ) : null}
                </div>
                <div className="home-action">
                    {loading || isPausing ? <div className="attendance-action-loading"><Spinner size="lg" /></div> : <div className="attendance-action-wrap animate-scale-in">
                        {!working && !dayIsOver ? <><span className="attendance-ripple" /><span className="attendance-ripple attendance-ripple-delay-1" /><span className="attendance-ripple attendance-ripple-delay-2" /></> : null}
                        {dayIsOver ? <div className={`attendance-action attendance-action-${attendanceState}`}><span className="material-symbols-rounded" aria-hidden="true">{actionIcon}</span><span>{actionLabel}</span></div> : <button onClick={runAttendanceAction} className={`attendance-action attendance-action-${attendanceState}`} type="button"><span className="material-symbols-rounded" aria-hidden="true">{actionIcon}</span><span>{actionLabel}</span></button>}
                    </div>}
                </div>
                <div className="home-stats-header app-section-header">
                    <h3 className="app-section-title">
                        <span className="material-symbols-rounded" aria-hidden="true">pie_chart</span> Thống kê
                    </h3>
                    <div className="app-period-control">
                        <button
                            type="button"
                            aria-label="Tháng trước"
                            onClick={() => changeMonth(-1)}
                            className="app-period-button"
                        >
                            <span className="material-symbols-rounded" aria-hidden="true">chevron_left</span>
                        </button>
                        <span className="app-period-label tabular-nums">
                            T{viewDate.getMonth() + 1}/{viewDate.getFullYear()}
                        </span>
                        <button
                            type="button"
                            aria-label="Tháng sau"
                            disabled={isNextMonthDisabled}
                            onClick={() => changeMonth(1)}
                            className="app-period-button"
                        >
                            <span className="material-symbols-rounded" aria-hidden="true">chevron_right</span>
                        </button>
                    </div>
                </div>
                <div className="home-stats-grid animate-slide-up"><StatCard title="Công chuẩn" value={stats.standardDays} sub={<span className="stat-label-bottom">ngày / tháng</span>} icon="calendar_today" color="blue" /><StatCard title="Công thực tế" value={stats.workDays} sub={<span className="stat-label-bottom">đã làm</span>} icon="check_circle" color="indigo" /><StatCard title="Công nghỉ lễ" value={stats.holidayDays} sub={<span className="stat-label-bottom">ngày</span>} icon="celebration" color="rose" /><StatCard title="Phép năm" value={`${stats.usedLeave}/${stats.totalLeave}`} sub={<span className="stat-label-bottom">đã dùng / tổng</span>} icon="beach_access" color="amber" /></div>
            </div>
        </PullToRefresh>
        {holidayConfirm.isOpen ? <div className="app-dialog-backdrop animate-fade-in"><div className="app-dialog animate-scale-in" role="alertdialog" aria-modal="true" aria-labelledby="holiday-dialog-title"><span className="app-dialog-icon status-tone-danger material-symbols-rounded" aria-hidden="true">celebration</span><h3 id="holiday-dialog-title">Hôm nay là ngày lễ</h3><strong className="status-tone-danger">{holidayConfirm.name}</strong><p>Hệ thống ghi nhận hôm nay là ngày nghỉ. Bạn có chắc chắn muốn chấm công làm việc không?</p><div className="app-dialog-actions"><button type="button" onClick={confirmHolidayWork} className="btn btn-primary btn-md"><span className="material-symbols-rounded" aria-hidden="true">work</span>Vẫn đi làm</button><button type="button" onClick={() => setHolidayConfirm({ isOpen:false, name:'' })} className="btn btn-secondary btn-md">Hủy bỏ</button></div></div></div> : null}
        {earlyCheckoutConfirm.isOpen ? <div className="app-dialog-backdrop animate-fade-in"><div className="app-dialog animate-scale-in" role="alertdialog" aria-modal="true" aria-labelledby="early-dialog-title"><span className="app-dialog-icon status-tone-warning material-symbols-rounded" aria-hidden="true">timer</span><h3 id="early-dialog-title">Bạn muốn về sớm?</h3><strong className="status-tone-warning">Sớm {earlyCheckoutConfirm.minutes} phút</strong><p>Bạn sẽ bị ghi nhận là về sớm nếu check-out ngay bây giờ. Bạn có chắc chắn muốn tiếp tục?</p><div className="app-dialog-actions"><button type="button" onClick={confirmEarlyCheckout} className="btn btn-danger btn-md"><span className="material-symbols-rounded" aria-hidden="true">meeting_room</span>Vẫn ra về</button><button type="button" onClick={() => setEarlyCheckoutConfirm({ isOpen:false, minutes:0 })} className="btn btn-secondary btn-md">Hủy bỏ</button></div></div></div> : null}
    </>;
};
export default TabHome;
