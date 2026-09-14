import React, { useState, useMemo, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { Attendance, DashboardData } from '@/shared/types';
import { toISODateString, triggerHaptic } from '@/core/utils/helpers';
import PullToRefresh from '@/shared/components/layout/PullToRefresh';
import { STORAGE_KEYS, TMS_DEFAULT_SYSTEM_CONFIG, TMS_LIMITS } from '@/shared/constants';
import type { RegisterSwipeHandler } from '@/modules/tms/components/BottomNav';
import { buildLocationNameMap } from '@/modules/tms/services/locations';

interface Props {
    data: DashboardData | null;
    onRefresh: () => Promise<void>;
    onAlert: (title: string, msg: string, type: 'success' | 'error' | 'warning') => void;
    onExplain: (date: string, reason: string) => void;
    registerSwipeHandler?: RegisterSwipeHandler;
}

type HistoryStatus = 'Absent' | 'Leave' | 'Holiday' | 'Full' | 'Half' | 'Working' | 'Weekend' | 'Future';

interface HistoryDayItem {
    date: string;
    dayOfWeek: number;
    dayNum: number;
    status: HistoryStatus;
    workHours: number;
    lateMins: number;
    earlyMins: number;
    shiftInfo: string;
    showExplain: boolean;
    isExplained: boolean;
    explainReason: string;
    isMissingCheckout: boolean;
    isLate: boolean;
    isEarly: boolean;
    leaveType: string;
    isHoliday: boolean;
    explainStatus?: 'Pending' | 'Approved' | 'Rejected';
    records?: Attendance[];
}

interface ProcessedHistoryData {
    stats: { workDays: number; lateMins: number; errors: number; lateDays: number; standardDays: number };
    list: HistoryDayItem[];
    title: string;
    calendarGrid: Array<HistoryDayItem | null>;
}

/** Colour is reserved for exceptions. Ordinary work, future days and weekends
 *  stay neutral so warnings and errors remain visible at a glance. */
function dayTone(item: HistoryDayItem): string {
    if (item.status === 'Absent' || item.isMissingCheckout) return 'danger';
    if (item.isLate || item.isEarly) return 'warning';
    if (item.status === 'Holiday' || item.status === 'Leave' || item.status === 'Half') return 'primary';
    if (item.status === 'Weekend' || item.status === 'Future') return 'muted';
    return 'muted';
}

const TabHistory: React.FC<Props> = ({ data, onRefresh, onAlert, onExplain, registerSwipeHandler }) => {
    const [viewMode, setViewMode] = useState<'week' | 'month'>(() =>
        (localStorage.getItem(STORAGE_KEYS.HISTORY_VIEW) as 'week' | 'month') || 'week'
    );

    useEffect(() => {
        if (registerSwipeHandler) {
            return registerSwipeHandler((direction) => {
                if (direction === 'left' && viewMode === 'week') {
                    triggerHaptic('light');
                    setViewMode('month');
                    return true;
                }
                if (direction === 'right' && viewMode === 'month') {
                    triggerHaptic('light');
                    setViewMode('week');
                    return true;
                }
                return false;
            });
        }
        return undefined;
    }, [registerSwipeHandler, viewMode]);

    useEffect(() => {
        localStorage.setItem(STORAGE_KEYS.HISTORY_VIEW, viewMode);
    }, [viewMode]);

    const [viewDate, setViewDate] = useState<Date>(new Date());
    const [selectedDate, setSelectedDate] = useState<string>(() => toISODateString(new Date()));
    const [expandedDate, setExpandedDate] = useState<string | null>(null);

    const handleExplainClick = (e: React.MouseEvent, dateStr: string, defaultReason: string) => {
        e.stopPropagation();
        triggerHaptic('light');
        if (!data) return;

        const attDate = new Date(`${dateStr}T00:00:00`);
        const now = new Date();

        const nextMonth = new Date(attDate.getFullYear(), attDate.getMonth() + 1, 1);
        const configuredLockDay = data.systemConfig.LOCK_DATE ?? TMS_DEFAULT_SYSTEM_CONFIG.LOCK_DATE ?? 1;
        const lastDayOfNextMonth = new Date(nextMonth.getFullYear(), nextMonth.getMonth() + 1, 0).getDate();
        const lockDay = Math.min(lastDayOfNextMonth, Math.max(1, Math.floor(configuredLockDay)));
        const deadline = new Date(nextMonth.getFullYear(), nextMonth.getMonth(), lockDay + 1);

        if (now >= deadline) {
            onAlert("Quá hạn giải trình", `Chỉ được giải trình đến hết ngày ${lockDay} của tháng kế tiếp.`, "error");
            return;
        }

        const targetMonth = attDate.getMonth();
        const targetYear = attDate.getFullYear();

        const count = data.myExplanations.filter(r => {
            const rDate = new Date(`${r.date}T00:00:00`);
            return r.status !== 'Rejected' &&
                rDate.getMonth() === targetMonth &&
                rDate.getFullYear() === targetYear;
        }).length;

        const maxPerMonth = data.systemConfig.MAX_EXPLANATIONS_PER_MONTH ?? TMS_LIMITS.MAX_EXPLANATIONS_PER_MONTH;
        if (count >= maxPerMonth) {
            onAlert("Đạt giới hạn", `Bạn chỉ được gửi tối đa ${maxPerMonth} giải trình mỗi tháng.`, "error");
            return;
        }

        onExplain(dateStr, defaultReason);
    };

    const locationsMap = useMemo(() => buildLocationNameMap(data), [data]);

    const processedData = useMemo<ProcessedHistoryData>(() => {
        if (!data) return { stats: { workDays: 0, lateMins: 0, errors: 0, lateDays: 0, standardDays: 0 }, list: [], title: '', calendarGrid: [] };

        const stats = { workDays: 0, lateMins: 0, errors: 0, lateDays: 0, standardDays: 0 };
        const list: HistoryDayItem[] = [];
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const { systemConfig } = data;
        const minFull = systemConfig?.MIN_HOURS_FULL ?? TMS_DEFAULT_SYSTEM_CONFIG.MIN_HOURS_FULL;
        const minHalf = systemConfig?.MIN_HOURS_HALF ?? TMS_DEFAULT_SYSTEM_CONFIG.MIN_HOURS_HALF;
        const offDays = Array.isArray(systemConfig?.OFF_DAYS) ? systemConfig.OFF_DAYS : TMS_DEFAULT_SYSTEM_CONFIG.OFF_DAYS;

        let startDate: Date, endDate: Date, title: string;

        if (viewMode === 'month') {
            const year = viewDate.getFullYear();
            const month = viewDate.getMonth();
            startDate = new Date(year, month, 1);
            endDate = new Date(year, month + 1, 0);
            title = `THÁNG ${month + 1}/${year}`;
        } else {
            endDate = new Date(viewDate);
            endDate.setHours(23, 59, 59);

            startDate = new Date(endDate);
            startDate.setDate(endDate.getDate() - 6);
            startDate.setHours(0, 0, 0, 0);

            const sD = startDate.getDate();
            const eD = endDate.getDate();
            const sM = startDate.getMonth() + 1;
            const eM = endDate.getMonth() + 1;

            title = (sM === eM)
                ? `${sD} - ${eD} THG ${sM}`
                : `${sD}/${sM} - ${eD}/${eM}`;
        }

        const dateInfoMap: Record<string, HistoryDayItem> = {};

        const loopEnd = new Date(endDate);
        const loopPtr = new Date(startDate);

        while (loopPtr <= loopEnd) {
            const dateStr = toISODateString(loopPtr);
            const dayOfWeek = loopPtr.getDay();

            const dayItem: HistoryDayItem = {
                date: dateStr,
                dayOfWeek: dayOfWeek,
                dayNum: loopPtr.getDate(),
                status: 'Absent',
                workHours: 0,
                lateMins: 0,
                earlyMins: 0,
                shiftInfo: "Không chấm công",
                showExplain: false,
                isExplained: false,
                explainReason: '',
                isMissingCheckout: false,
                isLate: false,
                isEarly: false,
                leaveType: '',
                isHoliday: false,
            };

            const isOffDay = offDays.includes(dayOfWeek);
            const isPublicHoliday = (data.holidays || []).some(h => h.active !== false && h.from_date <= dateStr && h.to_date >= dateStr);
            if (!isOffDay && !isPublicHoliday) stats.standardDays += 1;

            const existingExplain = data.myExplanations.find(r => r.date === dateStr);
            const isApproved = existingExplain?.status === 'Approved';

            if (existingExplain) {
                dayItem.isExplained = existingExplain.status !== 'Rejected';
                dayItem.explainStatus = existingExplain.status as 'Pending' | 'Approved' | 'Rejected';
            }

            const leave = data.myRequests.find(r =>
                r.status === 'Approved' &&
                r.from_date <= dateStr && r.to_date >= dateStr
            );

            if (leave) {
                dayItem.status = 'Leave';
                dayItem.shiftInfo = leave.type;
                dayItem.leaveType = leave.type;
                dayItem.workHours = minFull;
                stats.workDays += 1;
            } else {
                const holiday = data.holidays?.find(h => h.active !== false && h.from_date <= dateStr && h.to_date >= dateStr);
                if (holiday) {
                    dayItem.status = 'Holiday';
                    dayItem.shiftInfo = holiday.name || "Ngày Lễ";
                    dayItem.isHoliday = true;
                    dayItem.workHours = minFull;
                    stats.workDays += 1;
                } else {
                    const dailyRecords = data.history.history.filter(h => h.date === dateStr && Boolean(h.time_in));

                    if (dailyRecords.length > 0) {
                        dayItem.records = dailyRecords;
                        let totalHours = 0;
                        let totalLate = 0;
                        let totalEarly = 0;

                        dailyRecords.forEach(att => {
                            totalHours += Number(att.work_hours || 0);
                            totalLate += Number(att.late_minutes || 0);
                            totalEarly += Number(att.early_minutes || 0);
                        });

                        dayItem.workHours = totalHours;
                        dayItem.lateMins = totalLate;
                        dayItem.earlyMins = totalEarly;
                        stats.lateMins += totalLate;

                        const shiftNames = Array.from(new Set(dailyRecords.map((record) => record.shift_name).filter((name): name is string => Boolean(name))));
                        if (shiftNames.length > 0) {
                            dayItem.shiftInfo = shiftNames.join(', ');
                        } else {
                            dayItem.shiftInfo = `Đã chấm công`;
                        }

                        if (isApproved) {
                            stats.workDays += (totalHours >= minFull ? 1 : totalHours >= minHalf ? 0.5 : 1);
                            dayItem.workHours = Math.max(dayItem.workHours, minFull);
                            dayItem.status = 'Full';
                        } else if (totalHours >= minFull) {
                            stats.workDays += 1;
                            dayItem.status = 'Full';
                        } else if (totalHours >= minHalf) {
                            stats.workDays += 0.5;
                            dayItem.status = 'Half';
                        } else {
                            dayItem.status = 'Working';
                        }

                        const hasMissingOut = dailyRecords.some(r => !r.time_out);
                        if (hasMissingOut && dateStr !== toISODateString(today)) {
                            dayItem.isMissingCheckout = true;
                            if (!isApproved) {
                                stats.errors += 1;
                            }
                            dayItem.showExplain = true;
                            dayItem.explainReason = "[Lỗi] ";
                        }

                        if (totalLate > 0 && dateStr !== toISODateString(today)) {
                            dayItem.isLate = true;
                            stats.lateDays += 1;
                            dayItem.showExplain = true;
                            if (!dayItem.explainReason) dayItem.explainReason = "[Trễ] ";
                        }

                        if (totalEarly > 0 && dateStr !== toISODateString(today)) {
                            dayItem.isEarly = true;
                            dayItem.showExplain = true;
                            if (!dayItem.explainReason) dayItem.explainReason = "[Sớm] ";
                        }
                    } else {
                        if (offDays.includes(dayOfWeek)) {
                            dayItem.status = 'Weekend';
                            dayItem.shiftInfo = "Nghỉ toàn hệ thống";
                        } else if (loopPtr < today) {
                            if (isApproved) {
                                dayItem.status = 'Full';
                                dayItem.shiftInfo = "Đã duyệt giải trình";
                                dayItem.workHours = minFull;
                                stats.workDays += 1;
                                dayItem.showExplain = true;
                            } else {
                                dayItem.status = 'Absent';
                                dayItem.shiftInfo = "Vắng mặt";
                                dayItem.showExplain = true;
                                dayItem.explainReason = "[Vắng] ";

                                const todayStr = toISODateString(today);
                                if (dateStr < todayStr) {
                                    stats.errors += 1;
                                }
                            }
                        } else if (loopPtr.getTime() === today.getTime()) {
                            dayItem.status = 'Future';
                            dayItem.shiftInfo = "Chưa có dữ liệu";
                        } else {
                            dayItem.status = 'Future';
                            dayItem.shiftInfo = "-";
                        }
                    }
                }
            }

            dateInfoMap[dateStr] = dayItem;
            list.push(dayItem);

            loopPtr.setDate(loopPtr.getDate() + 1);
        }

        const filteredList = [...list];
        filteredList.reverse();

        const calendarGrid: Array<HistoryDayItem | null> = [];
        if (viewMode === 'month') {
            const firstDay = startDate.getDay();
            for (let i = 0; i < firstDay; i++) {
                calendarGrid.push(null);
            }
            const ptrMonth = new Date(startDate);
            while (ptrMonth <= endDate) {
                const dStr = toISODateString(ptrMonth);
                calendarGrid.push(dateInfoMap[dStr] ?? null);
                ptrMonth.setDate(ptrMonth.getDate() + 1);
            }
        }

        return { stats, list: filteredList, title, calendarGrid };
    }, [data, viewDate, viewMode]);

    const changeDate = (delta: number) => {
        triggerHaptic('light');
        const newDate = new Date(viewDate);
        if (viewMode === 'month') {
            newDate.setMonth(newDate.getMonth() + delta);
        } else {
            newDate.setDate(newDate.getDate() + (delta * 7));
        }
        setViewDate(newDate);
        if (viewMode === 'month') {
            setSelectedDate(toISODateString(newDate));
        }
    };

    const isCurrentView = useMemo(() => {
        const today = new Date();
        if (viewMode === 'week') {
            const d = new Date(viewDate);
            return d.setHours(0, 0, 0, 0) >= today.setHours(0, 0, 0, 0);
        } else {
            return viewDate.getMonth() === today.getMonth() && viewDate.getFullYear() === today.getFullYear();
        }
    }, [viewDate, viewMode]);

    const getDayName = (idx: number) => ["CN", "Hai", "Ba", "Tư", "Năm", "Sáu", "Bảy"][idx];

    const { stats, list, title, calendarGrid } = processedData;

    const displayList = (viewMode === 'week'
        ? list
        : (list.filter(item => item.date === selectedDate))
    ).filter(item => item.status !== 'Future');

    const switchViewMode = (mode: 'week' | 'month') => {
        triggerHaptic('light');
        setViewMode(mode);
        if (mode === 'month') setSelectedDate(toISODateString(viewDate));
    };

    /** Explanations close on the configured lock day of the following month.
     *  Staff need that date on screen, not buried in an error toast. */
    const explanationWindow = useMemo(() => {
        const anchor = viewMode === 'month'
            ? new Date(viewDate.getFullYear(), viewDate.getMonth(), 1)
            : viewDate;
        const configured = data?.systemConfig?.LOCK_DATE ?? TMS_DEFAULT_SYSTEM_CONFIG.LOCK_DATE ?? 1;
        const nextMonth = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1);
        const lastDay = new Date(nextMonth.getFullYear(), nextMonth.getMonth() + 1, 0).getDate();
        const lockDay = Math.min(lastDay, Math.max(1, Math.floor(configured)));
        const deadline = new Date(nextMonth.getFullYear(), nextMonth.getMonth(), lockDay);
        return {
            label: `${String(deadline.getDate()).padStart(2, '0')}/${String(deadline.getMonth() + 1).padStart(2, '0')}/${deadline.getFullYear()}`,
            isOpen: new Date() <= new Date(deadline.getFullYear(), deadline.getMonth(), deadline.getDate() + 1),
        };
    }, [data?.systemConfig?.LOCK_DATE, viewDate, viewMode]);

    const standardRatio = stats.standardDays > 0 ? (stats.workDays / stats.standardDays) * 100 : null;

    return (
        <PullToRefresh onRefresh={onRefresh} className="page-bg font-sans">
            <div className="employee-page employee-page-standard history-page animate-fade-in ui-stack">

                <div className="requests-switch history-view-switch">
                    <button
                        type="button"
                        aria-pressed={viewMode === 'week'}
                        onClick={() => switchViewMode('week')}
                        className={`requests-switch-option ${viewMode === 'week' ? 'requests-switch-option-active' : ''}`.trim()}
                    >
                        <span className="material-symbols-rounded" aria-hidden="true">date_range</span>
                        <span className="requests-switch-text">
                            <span className="requests-switch-label">Tuần này</span>
                            <span className="requests-switch-sub">7 ngày gần nhất</span>
                        </span>
                    </button>
                    <button
                        type="button"
                        aria-pressed={viewMode === 'month'}
                        onClick={() => switchViewMode('month')}
                        className={`requests-switch-option ${viewMode === 'month' ? 'requests-switch-option-active' : ''}`.trim()}
                    >
                        <span className="material-symbols-rounded" aria-hidden="true">calendar_month</span>
                        <span className="requests-switch-text">
                            <span className="requests-switch-label">Tháng này</span>
                            <span className="requests-switch-sub">Theo kỳ công tháng</span>
                        </span>
                    </button>
                </div>

                {/* Period ------------------------------------------------- */}
                <section className="ui-card">
                    <div className="ui-card-head">
                        <span className="ui-tile ui-tone-primary" aria-hidden="true">
                            <span className="material-symbols-rounded">event_note</span>
                        </span>
                        <span className="ui-card-head-text">
                            <span className="ui-card-head-title">
                                {viewMode === 'month' ? 'Kỳ công tháng' : 'Kỳ công tuần'} · {title}
                            </span>
                            <span className="ui-card-head-sub">
                                {stats.standardDays} ngày công chuẩn trong kỳ
                            </span>
                        </span>
                        <div className="app-period-control">
                            <button type="button" className="app-period-button" aria-label="Kỳ trước" onClick={() => changeDate(-1)}>
                                <span className="material-symbols-rounded" aria-hidden="true">chevron_left</span>
                            </button>
                            <button
                                type="button"
                                className="app-period-button"
                                aria-label="Kỳ sau"
                                disabled={isCurrentView}
                                onClick={() => changeDate(1)}
                            >
                                <span className="material-symbols-rounded" aria-hidden="true">chevron_right</span>
                            </button>
                        </div>
                    </div>

                    <div className="ui-card-section history-lock">
                        <span className="history-lock-text">
                            <span className="material-symbols-rounded" aria-hidden="true">lock_clock</span>
                            <span>Hạn khóa bảng công: <strong>{explanationWindow.label}</strong></span>
                        </span>
                        <span className={`ui-pill ${explanationWindow.isOpen ? 'ui-pill-success' : 'ui-pill-muted'}`}>
                            {explanationWindow.isOpen ? 'Đang mở' : 'Đã khóa'}
                        </span>
                    </div>
                </section>

                {/* Figures ------------------------------------------------ */}
                <div className="ui-metrics">
                    <div className="ui-metric">
                        <span className="ui-metric-head">
                            <span>Ngày công</span>
                            <span className="material-symbols-rounded ui-tone-success" aria-hidden="true">task_alt</span>
                        </span>
                        <span className="ui-metric-value">
                            {stats.workDays}
                            <span className="ui-metric-unit">/{stats.standardDays}</span>
                        </span>
                        <span className="ui-metric-foot">
                            {standardRatio !== null ? `${standardRatio.toFixed(1)}% chuẩn` : 'Chưa có ngày công chuẩn'}
                        </span>
                    </div>

                    <div className="ui-metric">
                        <span className="ui-metric-head">
                            <span>Đi trễ</span>
                            <span className="material-symbols-rounded ui-tone-warning" aria-hidden="true">schedule</span>
                        </span>
                        <span className={`ui-metric-value ${stats.lateMins > 0 ? 'ui-tone-warning' : ''}`.trim()}>
                            {stats.lateMins}
                            <span className="ui-metric-unit">phút</span>
                        </span>
                        <span className="ui-metric-foot">
                            {stats.lateDays > 0 ? `${stats.lateDays} lượt vi phạm` : 'Không có lượt trễ'}
                        </span>
                    </div>

                    <div className={`ui-metric ${stats.errors > 0 ? 'ui-metric-attention' : ''}`.trim()}>
                        <span className="ui-metric-head">
                            <span>Lỗi chấm</span>
                            <span className="material-symbols-rounded ui-tone-danger" aria-hidden="true">error</span>
                        </span>
                        <span className={`ui-metric-value ${stats.errors > 0 ? 'ui-tone-danger' : ''}`.trim()}>
                            {stats.errors}
                            <span className="ui-metric-unit">lượt</span>
                        </span>
                        <span className={`ui-metric-foot ${stats.errors > 0 ? 'ui-tone-danger' : ''}`.trim()}>
                            {stats.errors > 0 ? 'Cần giải trình' : 'Bảng công sạch'}
                        </span>
                    </div>
                </div>

                {/* Month matrix ------------------------------------------- */}
                {viewMode === 'month' && (
                    <section className="ui-card ui-card-pad animate-scale-in">
                        <div className="ui-cal">
                            {["CN", "T2", "T3", "T4", "T5", "T6", "T7"].map((d, i) => (
                                <div key={d} className={`ui-cal-head ${i === 0 ? 'ui-cal-head-sun' : ''}`.trim()}>{d}</div>
                            ))}
                            {calendarGrid.map((day, idx) => {
                                if (!day) return <div key={`blank-${idx}`} className="ui-cal-day ui-cal-day-blank" aria-hidden="true" />;
                                const isSelected = day.date === selectedDate;
                                const tone = dayTone(day);
                                return (
                                    <button
                                        type="button"
                                        aria-pressed={isSelected}
                                        key={day.date}
                                        onClick={() => { triggerHaptic('light'); setSelectedDate(day.date); }}
                                        className={`ui-cal-day ${day.dayOfWeek === 0 && !isSelected ? 'ui-cal-day-sun' : ''} ${isSelected ? 'ui-cal-day-selected' : ''}`.trim()}
                                    >
                                        <span>{day.dayNum}</span>
                                        {day.status !== 'Future' ? (
                                            <span className={`history-cal-dot ui-tone-${tone}`} aria-hidden="true" />
                                        ) : null}
                                    </button>
                                );
                            })}
                        </div>
                    </section>
                )}

                {/* Day log ------------------------------------------------ */}
                {displayList.length === 0 ? (
                    <div className="ui-empty">
                        <span className="material-symbols-rounded" aria-hidden="true">calendar_today</span>
                        <span className="ui-empty-title">{viewMode === 'month' ? 'Chọn một ngày để xem chi tiết' : 'Không có dữ liệu trong kỳ'}</span>
                    </div>
                ) : (
                    <div className="ui-stack">
                        {displayList.map((item) => {
                            const isExpanded = expandedDate === item.date;
                            const records = item.records ?? [];
                            const tone = dayTone(item);
                            const hasError = item.isMissingCheckout || item.status === 'Absent';

                            return (
                                <section key={item.date} className={`ui-card ${hasError && !item.isExplained ? 'ui-card-attention' : ''}`.trim()}>
                                    <div className="history-day">
                                        <div className="history-day-head">
                                            <span className={`ui-daytag ui-daytag-toned ui-tone-${tone}`} aria-hidden="true">
                                                <span className="ui-daytag-dow">{getDayName(item.dayOfWeek)}</span>
                                                <span className="ui-daytag-num">{item.dayNum}</span>
                                            </span>

                                            <div className="history-day-title">
                                                <h4>
                                                    <span className={`history-day-dot ui-tone-${tone}`} aria-hidden="true" />
                                                    <span>{item.shiftInfo}</span>
                                                </h4>
                                                <p>
                                                    {item.status !== 'Future' && item.status !== 'Absent' && item.status !== 'Weekend'
                                                        ? `${item.workHours.toFixed(2)} giờ công${item.lateMins ? ` (-${item.lateMins}p)` : ''}`
                                                        : item.status === 'Absent' ? 'Không có dữ liệu chấm công'
                                                            : item.status === 'Weekend' ? 'Không có ca làm việc' : 'Chưa đến'}
                                                </p>
                                            </div>

                                            <div className="history-day-badges">
                                                {item.status === 'Leave' && <span className="ui-pill ui-pill-primary">{item.leaveType}</span>}
                                                {item.status === 'Holiday' && <span className="ui-pill ui-pill-primary">Nghỉ lễ</span>}
                                                {item.status === 'Weekend' && <span className="ui-pill ui-pill-muted">Cuối tuần</span>}
                                                {item.status === 'Absent' && <span className="ui-pill ui-pill-danger">Vắng mặt</span>}
                                                {item.isMissingCheckout && <span className="ui-pill ui-pill-danger"><span className="ui-pill-dot" aria-hidden="true" />Lỗi ra</span>}
                                                {item.isLate && <span className="ui-pill ui-pill-warning"><span className="ui-pill-dot" aria-hidden="true" />Trễ {item.lateMins}p</span>}
                                                {item.isEarly && <span className="ui-pill ui-pill-warning"><span className="ui-pill-dot" aria-hidden="true" />Sớm {item.earlyMins}p</span>}
                                                {item.status === 'Full' && !item.isLate && !item.isEarly && !item.isMissingCheckout && (
                                                    <span className="ui-pill ui-pill-success"><span className="ui-pill-dot" aria-hidden="true" />Đúng giờ</span>
                                                )}
                                                {item.status === 'Half' && !item.isLate && !item.isEarly && !item.isMissingCheckout && (
                                                    <span className="ui-pill ui-pill-primary">Nửa ca</span>
                                                )}

                                                {(item.showExplain || item.explainStatus) && (
                                                    item.explainStatus === 'Approved' ? (
                                                        <span className="ui-pill ui-pill-success"><span className="material-symbols-rounded" aria-hidden="true">verified</span>Đã duyệt</span>
                                                    ) : item.explainStatus === 'Pending' ? (
                                                        <span className="ui-pill ui-pill-warning"><span className="material-symbols-rounded" aria-hidden="true">schedule</span>Chờ duyệt</span>
                                                    ) : (
                                                        <button
                                                            type="button"
                                                            onClick={(e) => handleExplainClick(e, item.date, item.explainReason)}
                                                            className="history-explain-button"
                                                        >
                                                            <span className="material-symbols-rounded" aria-hidden="true">edit_document</span>
                                                            {item.explainStatus === 'Rejected' ? 'Gửi lại' : 'Giải trình'}
                                                        </button>
                                                    )
                                                )}
                                                {records.length > 0 && (
                                                    <button
                                                        type="button"
                                                        className="history-expand-button"
                                                        aria-expanded={isExpanded}
                                                        aria-label={isExpanded ? 'Thu gọn chi tiết chấm công' : 'Mở chi tiết chấm công'}
                                                        onClick={() => { triggerHaptic('light'); setExpandedDate(isExpanded ? null : item.date); }}
                                                    >
                                                        <span className={`material-symbols-rounded ${isExpanded ? 'history-expand-icon-open' : ''}`.trim()} aria-hidden="true">expand_more</span>
                                                    </button>
                                                )}
                                            </div>
                                        </div>

                                        {records.length > 0 && (
                                            <div className="history-day-timelines">
                                                {records.map((rec, rIdx) => (
                                                    <div key={`${item.date}-${rIdx}`} className={`ui-timeline ${rec.time_out ? '' : 'ui-timeline-broken'}`.trim()}>
                                                        <span className="ui-timeline-end">
                                                            <span className="ui-timeline-label">Vào {records.length > 1 ? rIdx + 1 : ''}</span>
                                                            <span className="ui-timeline-time">{rec.time_in || '--:--'}</span>
                                                        </span>
                                                        <span className="ui-timeline-track" aria-hidden="true">
                                                            <span className="ui-timeline-node" />
                                                            <span className="ui-timeline-line" />
                                                            <span className="ui-timeline-node ui-timeline-node-end" />
                                                            {!rec.time_out && (
                                                                <span className="ui-timeline-cross">
                                                                    <span className="material-symbols-rounded">close</span>
                                                                </span>
                                                            )}
                                                        </span>
                                                        <span className="ui-timeline-end ui-timeline-end-out">
                                                            <span className="ui-timeline-label">Ra {records.length > 1 ? rIdx + 1 : ''}</span>
                                                            <span className={`ui-timeline-time ${rec.time_out ? '' : 'ui-timeline-time-missing'}`.trim()}>
                                                                {rec.time_out || '--:--'}
                                                            </span>
                                                        </span>
                                                    </div>
                                                ))}
                                            </div>
                                        )}

                                        {hasError && !item.isExplained && (
                                            <p className="history-day-hint">
                                                <span className="material-symbols-rounded" aria-hidden="true">schedule</span>
                                                Hạn giải trình: {explanationWindow.label}
                                            </p>
                                        )}
                                    </div>

                                    <AnimatePresence initial={false}>
                                        {isExpanded && records.length > 0 && (
                                            <motion.div
                                                initial={{ height: 0, opacity: 0 }}
                                                animate={{ height: 'auto', opacity: 1 }}
                                                exit={{ height: 0, opacity: 0 }}
                                                transition={{ duration: 0.2 }}
                                                className="overflow-hidden"
                                            >
                                                <div className="ui-card-section">
                                                    {records.map((rec, rIdx) => (
                                                        <div key={`detail-${item.date}-${rIdx}`} className="ui-row">
                                                            <span className="ui-row-icon ui-tone-muted" aria-hidden="true">
                                                                <span className="material-symbols-rounded">location_on</span>
                                                            </span>
                                                            <span className="ui-row-body">
                                                                <span className="ui-row-label">
                                                                    Lần chấm công {records.length > 1 ? rIdx + 1 : ''} · {rec.checkin_type}
                                                                </span>
                                                                <span className="ui-row-value">
                                                                    {rec.location_name || locationsMap[rec.center_id] || rec.center_id}
                                                                </span>
                                                            </span>
                                                        </div>
                                                    ))}
                                                </div>
                                            </motion.div>
                                        )}
                                    </AnimatePresence>
                                </section>
                            );
                        })}
                    </div>
                )}
            </div>
        </PullToRefresh>
    );
};

export default TabHistory;
