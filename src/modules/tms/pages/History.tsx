import React, { useState, useMemo, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { Attendance, DashboardData } from '@/shared/types';
import { toISODateString, triggerHaptic } from '@/core/utils/helpers';
import PullToRefresh from '@/shared/components/layout/PullToRefresh';
import { STORAGE_KEYS, TMS_DEFAULT_SYSTEM_CONFIG } from '@/shared/constants';
import type { RegisterSwipeHandler } from '@/modules/tms/components/BottomNav';

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
    icon: string;
    iconClass: string;
    dotClass: string;
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
    stats: { workDays: number; lateMins: number; errors: number };
    list: HistoryDayItem[];
    title: string;
    calendarGrid: Array<HistoryDayItem | null>;
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

        if (count >= 5) {
            onAlert("Đạt giới hạn", "Bạn chỉ được gửi tối đa 5 giải trình mỗi tháng.", "error");
            return;
        }

        onExplain(dateStr, defaultReason);
    };

    const locationsMap = useMemo(() => {
        const map: Record<string, string> = {};
        data?.locations.forEach(loc => {
            map[loc.center_id] = loc.location_name || loc.center_name || loc.center_id;
        });
        return map;
    }, [data?.locations]);

    const processedData = useMemo<ProcessedHistoryData>(() => {
        if (!data) return { stats: { workDays: 0, lateMins: 0, errors: 0 }, list: [], title: '', calendarGrid: [] };

        const stats = { workDays: 0, lateMins: 0, errors: 0 };
        const list: HistoryDayItem[] = [];
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const { systemConfig } = data;
        const minFull = systemConfig?.MIN_HOURS_FULL || 7;
        const minHalf = systemConfig?.MIN_HOURS_HALF || 3.5;
        const offDays = Array.isArray(systemConfig?.OFF_DAYS) ? systemConfig.OFF_DAYS : [0];

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
                icon: 'close',
                iconClass: 'bg-secondary-red/10 dark:bg-secondary-red/20 text-secondary-red dark:text-secondary-red',
                dotClass: 'bg-secondary-red',
                showExplain: false,
                isExplained: false,
                explainReason: '',
                isMissingCheckout: false,
                isLate: false,
                isEarly: false,
                leaveType: '',
                isHoliday: false,
            };

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
                dayItem.shiftInfo = "Nghỉ phép";
                dayItem.leaveType = leave.type;
                dayItem.icon = 'redeem';
                dayItem.iconClass = 'bg-secondary-purple/10 dark:bg-secondary-purple/20 text-secondary-purple dark:text-secondary-purple';
                dayItem.dotClass = 'bg-secondary-purple';
                dayItem.workHours = 8;
                stats.workDays += 1;
            } else {
                const holiday = data.holidays?.find(h => h.from_date <= dateStr && h.to_date >= dateStr);
                if (holiday) {
                    dayItem.status = 'Holiday';
                    dayItem.shiftInfo = holiday.name || "Ngày Lễ";
                    dayItem.isHoliday = true;
                    dayItem.icon = 'celebration';
                    dayItem.iconClass = 'bg-secondary-red/10 dark:bg-secondary-red/20 text-secondary-red dark:text-secondary-red ring-1 ring-secondary-red/20 dark:ring-secondary-red/30';
                    dayItem.dotClass = 'bg-secondary-red';
                    dayItem.workHours = 8;
                    stats.workDays += 1;
                } else {
                    const dailyRecords = data.history.history.filter(h => h.date === dateStr);

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
                            dayItem.workHours = Math.max(dayItem.workHours, 8);
                            dayItem.status = 'Full';
                            dayItem.icon = 'check';
                            dayItem.iconClass = 'bg-primary/10 dark:bg-primary/20 text-primary dark:text-primary';
                            dayItem.dotClass = 'bg-primary';
                        } else if (totalHours >= minFull) {
                            stats.workDays += 1;
                            dayItem.status = 'Full';
                            dayItem.icon = 'check';
                            dayItem.iconClass = 'bg-primary/10 dark:bg-primary/20 text-primary dark:text-primary';
                            dayItem.dotClass = 'bg-primary';
                        } else if (totalHours >= minHalf) {
                            stats.workDays += 0.5;
                            dayItem.status = 'Half';
                            dayItem.icon = 'star_half';
                            dayItem.iconClass = 'bg-secondary-green/10 dark:bg-secondary-green/20 text-secondary-green dark:text-secondary-green';
                            dayItem.dotClass = 'bg-secondary-green';
                        } else {
                            dayItem.status = 'Working';
                            dayItem.icon = 'work';
                            dayItem.iconClass = 'bg-secondary-yellow/10 dark:bg-secondary-yellow/20 text-secondary-yellow dark:text-secondary-yellow';
                            dayItem.dotClass = 'bg-secondary-yellow';
                        }

                        const hasMissingOut = dailyRecords.some(r => !r.time_out);
                        if (hasMissingOut && dateStr !== toISODateString(today)) {
                            dayItem.isMissingCheckout = true;
                            if (!isApproved) {
                                stats.errors += 1;
                            }
                            dayItem.showExplain = true;
                            dayItem.explainReason = "[Lỗi] ";
                            dayItem.dotClass = isApproved ? 'bg-primary' : 'bg-secondary-red';
                        }

                        if (totalLate > 0 && dateStr !== toISODateString(today)) {
                            dayItem.isLate = true;
                            dayItem.showExplain = true;
                            if (!dayItem.explainReason) dayItem.explainReason = "[Trễ] ";
                            if (!dayItem.isMissingCheckout) dayItem.dotClass = isApproved ? 'bg-primary' : 'bg-secondary-yellow';
                        }

                        if (totalEarly > 0 && dateStr !== toISODateString(today)) {
                            dayItem.isEarly = true;
                            dayItem.showExplain = true;
                            if (!dayItem.explainReason) dayItem.explainReason = "[Sớm] ";
                            if (!dayItem.isMissingCheckout && !dayItem.isLate) dayItem.dotClass = isApproved ? 'bg-primary' : 'bg-secondary-yellow';
                        }
                    } else {
                        if (offDays.includes(dayOfWeek)) {
                            dayItem.status = 'Weekend';
                            dayItem.shiftInfo = "Nghỉ toàn hệ thống";
                            dayItem.icon = 'local_cafe';
                            dayItem.iconClass = 'bg-slate-50 dark:bg-dark-surface/50 text-slate-400 dark:text-dark-text-secondary';
                            dayItem.dotClass = 'bg-slate-300 dark:bg-dark-border';
                        } else if (loopPtr < today) {
                            if (isApproved) {
                                dayItem.status = 'Full';
                                dayItem.shiftInfo = "Đã duyệt giải trình";
                                dayItem.workHours = 8;
                                stats.workDays += 1;
                                dayItem.showExplain = true;
                                dayItem.icon = 'verified';
                                dayItem.iconClass = 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400 ring-1 ring-emerald-500/20';
                                dayItem.dotClass = 'bg-emerald-500';
                            } else {
                                dayItem.status = 'Absent';
                                dayItem.shiftInfo = "Vắng mặt";
                                dayItem.showExplain = true;
                                dayItem.explainReason = "[Vắng] ";
                                dayItem.icon = 'close';
                                dayItem.iconClass = 'bg-secondary-red/10 dark:bg-secondary-red/20 text-secondary-red dark:text-secondary-red';
                                dayItem.dotClass = 'bg-secondary-red';

                                const todayStr = toISODateString(today);
                                if (dateStr < todayStr) {
                                    stats.errors += 1;
                                }
                            }
                        } else if (loopPtr.getTime() === today.getTime()) {
                            dayItem.status = 'Future';
                            dayItem.shiftInfo = "Chưa có dữ liệu";
                            dayItem.dotClass = 'bg-transparent';
                            dayItem.iconClass = 'bg-slate-50 dark:bg-dark-surface/50 text-slate-300 dark:text-dark-text-secondary/50';
                        } else {
                            dayItem.status = 'Future';
                            dayItem.shiftInfo = "-";
                            dayItem.dotClass = 'bg-transparent';
                            dayItem.iconClass = 'bg-slate-50 dark:bg-dark-surface/50 text-slate-300 dark:text-dark-text-secondary/50';
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
    };

    return (
        <PullToRefresh onRefresh={onRefresh} className="page-bg font-sans">
            <div className="employee-page employee-page-standard history-page animate-fade-in space-y-6">

                <div className="app-segmented">
                        <button
                            type="button"
                            onClick={() => switchViewMode('week')}
                            className={`app-segmented-option ${viewMode === 'week' ? 'app-segmented-option-active' : ''}`}
                        >
                            Tuần
                        </button>
                        <button
                            type="button"
                            onClick={() => switchViewMode('month')}
                            className={`app-segmented-option ${viewMode === 'month' ? 'app-segmented-option-active' : ''}`}
                        >
                            Tháng
                        </button>
                </div>

                <div className="app-kpi-grid">
                    <div className="app-kpi-card">
                        <strong className="status-tone-primary tabular-nums">{stats.workDays}</strong>
                        <span>Ngày công</span>
                    </div>
                    <div className="app-kpi-card">
                        <strong className="status-tone-warning tabular-nums">{stats.lateMins}</strong>
                        <span>Phút trễ</span>
                    </div>
                    <div className="app-kpi-card">
                        <strong className="status-tone-danger tabular-nums">{stats.errors}</strong>
                        <span>Lỗi chấm</span>
                    </div>
                </div>

                <div className="app-section-header">
                    <h3 className="app-section-title">
                        <span className="material-symbols-rounded" aria-hidden="true">history</span>
                        {viewMode === 'month' ? 'Nhật ký tháng' : 'Nhật ký tuần'}
                    </h3>

                    <div className="app-period-control">
                        <button
                            type="button"
                            aria-label="Kỳ trước"
                            onClick={() => changeDate(-1)}
                            className="app-period-button"
                        >
                            <span className="material-symbols-rounded" aria-hidden="true">chevron_left</span>
                        </button>
                        <span className="app-period-label tabular-nums">
                            {title}
                        </span>
                        <button
                            type="button"
                            aria-label="Kỳ sau"
                            disabled={isCurrentView}
                            onClick={() => changeDate(1)}
                            className="app-period-button"
                        >
                            <span className="material-symbols-rounded" aria-hidden="true">chevron_right</span>
                        </button>
                    </div>
                </div>

                {viewMode === 'month' && (
                    <div className="app-surface history-calendar animate-scale-in">
                        <div className="grid grid-cols-7 mb-4">
                            {["CN", "T2", "T3", "T4", "T5", "T6", "T7"].map((d, i) => (
                                <div key={i} className="text-center text-xxs font-extrabold text-slate-400 dark:text-dark-text-secondary uppercase tracking-wider">{d}</div>
                            ))}
                        </div>
                        <div className="grid grid-cols-7 gap-y-3 gap-x-1">
                            {calendarGrid.map((day, idx) => {
                                if (!day) return <div key={idx} className="h-10"></div>;
                                const isSelected = day.date === selectedDate;
                                return (
                                    <button
                                        type="button"
                                        aria-pressed={isSelected}
                                        key={idx}
                                        onClick={() => { triggerHaptic('light'); setSelectedDate(day.date); }}
                                        className={`w-full h-10 flex flex-col items-center justify-center relative cursor-pointer rounded-xl transition-all ${isSelected ? 'bg-primary/10 dark:bg-primary/20 ring-2 ring-primary/50 dark:ring-primary/40 text-primary dark:text-primary' : 'hover-surface text-slate-900 dark:text-dark-text-primary'}`}
                                    >
                                        <span className={`text-base font-bold tabular-nums ${day.dayOfWeek === 0 && !isSelected ? 'text-secondary-red dark:text-secondary-red' : ''}`}>{day.dayNum}</span>
                                        {day.status !== 'Future' && (
                                            <div className={`w-1.5 h-1.5 rounded-full mt-1 ${day.dotClass}`}></div>
                                        )}
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                )}

                {/* THẺ TIMELINE CHUẨN: LIỀN KHỐI (LIST VIEW), GỌN GÀNG MÀ VẪN SHOW TIMELINE */}
                {displayList.length === 0 ? (
                    <div className="w-full text-center py-12 text-sm font-bold text-slate-400 dark:text-dark-text-secondary bg-white dark:bg-dark-surface rounded-2xl border border-dashed border-slate-200 dark:border-dark-border mb-12 shadow-xs">
                        {viewMode === 'month' ? 'Chọn ngày để xem chi tiết' : 'Không có dữ liệu'}
                    </div>
                ) : (
                    <div className="app-list-surface history-list animate-slide-up divide-y divide-slate-100 dark:divide-dark-border">
                        {displayList.map((item, idx) => {
                            const isExpanded = expandedDate === item.date;
                            const records = item.records ?? [];

                            return (
                                <div key={idx}
                                    className="w-full hover-surface relative"
                                >
                                    {/* --- HEADER THẺ --- */}
                                    <div
                                        role="button"
                                        tabIndex={0}
                                        aria-expanded={isExpanded}
                                        onClick={() => { triggerHaptic('light'); setExpandedDate(isExpanded ? null : item.date); }}
                                        onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); triggerHaptic('light'); setExpandedDate(isExpanded ? null : item.date); } }}
                                        className="p-4 sm:p-5 cursor-pointer"
                                    >
                                        <div className="flex items-start justify-between mb-4">
                                            <div className="flex items-center gap-3.5">
                                                {/* Khối Ngày - aspect-square rounded-2xl không bao giờ bị méo */}
                                                <div className="w-12 h-12 shrink-0 aspect-square rounded-2xl bg-gradient-to-b from-slate-50 to-slate-100/80 dark:from-dark-bg/80 dark:to-dark-bg/50 border border-slate-200/60 dark:border-dark-border flex flex-col items-center justify-center shadow-xs">
                                                    <span className={`history-weekday font-extrabold uppercase leading-none tracking-wide mb-1 ${item.dayOfWeek === 0 ? 'text-secondary-red dark:text-secondary-red' : 'text-slate-400 dark:text-dark-text-secondary'}`}>{getDayName(item.dayOfWeek)}</span>
                                                    <span className={`text-base font-bold leading-none tabular-nums ${item.dayOfWeek === 0 ? 'text-secondary-red dark:text-secondary-red' : 'text-slate-800 dark:text-dark-text-primary'}`}>{item.dayNum}</span>
                                                </div>

                                                {/* Thông tin Ca */}
                                                <div>
                                                    <h4 className="text-base font-bold text-slate-800 dark:text-dark-text-primary leading-tight mb-1">{item.shiftInfo}</h4>
                                                    <div className="flex items-center gap-2 text-xxs font-bold text-slate-500 dark:text-dark-text-secondary">
                                                        {item.status !== 'Future' && item.status !== 'Absent' && item.status !== 'Weekend' ? (
                                                            <span className="flex items-center gap-1.5">
                                                                <span className="w-4 h-4 shrink-0 aspect-square rounded-full bg-slate-100 dark:bg-dark-border/60 flex items-center justify-center">
                                                                    <span className="material-symbols-rounded text-xs leading-none">work</span>
                                                                </span>
                                                                {item.workHours.toFixed(1)} giờ công
                                                            </span>
                                                        ) : (
                                                            <span className="flex items-center gap-1 uppercase tracking-widest text-xxs">
                                                                {item.status === 'Absent' ? 'Không có dữ liệu' : (item.status === 'Weekend' ? 'Ngày nghỉ' : 'Chưa đến')}
                                                            </span>
                                                        )}
                                                    </div>
                                                </div>
                                            </div>

                                            {/* Cụm Badges Góc Phải (Xếp chồng) */}
                                            <div className="flex flex-col items-end gap-1.5 pl-2 shrink-0">
                                                {item.status === 'Leave' && (
                                                    <span className="inline-flex items-center gap-1 h-6 min-h-0 px-2.5 rounded-full bg-secondary-purple/10 dark:bg-secondary-purple/20 text-secondary-purple dark:text-secondary-purple border border-secondary-purple/20 dark:border-secondary-purple/30 text-xxs font-extrabold uppercase tracking-wider leading-none whitespace-nowrap">
                                                        {item.leaveType}
                                                    </span>
                                                )}
                                                {item.status === 'Holiday' && (
                                                    <span className="inline-flex items-center gap-1 h-6 min-h-0 px-2.5 rounded-full bg-secondary-red/10 dark:bg-secondary-red/20 text-secondary-red dark:text-secondary-red border border-secondary-red/20 dark:border-secondary-red/30 text-xxs font-extrabold uppercase tracking-wider leading-none whitespace-nowrap">
                                                        Nghỉ Lễ
                                                    </span>
                                                )}
                                                {item.status === 'Weekend' && (
                                                    <span className="inline-flex items-center gap-1 h-6 min-h-0 px-2.5 rounded-full bg-slate-100 dark:bg-dark-border/50 text-slate-500 dark:text-dark-text-secondary border border-slate-200 dark:border-dark-border text-xxs font-extrabold uppercase tracking-wider leading-none whitespace-nowrap">
                                                        Nghỉ tuần
                                                    </span>
                                                )}
                                                {item.status === 'Absent' && (
                                                    <span className="inline-flex items-center gap-1 h-6 min-h-0 px-2.5 rounded-full bg-secondary-red/10 dark:bg-secondary-red/20 text-secondary-red dark:text-secondary-red border border-secondary-red/20 dark:border-secondary-red/30 text-xxs font-extrabold uppercase tracking-wider leading-none whitespace-nowrap">
                                                        Vắng mặt
                                                    </span>
                                                )}
                                                {item.isMissingCheckout && (
                                                    <span className="inline-flex items-center gap-1 h-6 min-h-0 px-2.5 rounded-full bg-secondary-red/10 dark:bg-secondary-red/20 text-secondary-red dark:text-secondary-red border border-secondary-red/20 dark:border-secondary-red/30 text-xxs font-extrabold uppercase tracking-wider leading-none whitespace-nowrap">
                                                        Lỗi Checkout
                                                    </span>
                                                )}
                                                {item.isLate && (
                                                    <span className="inline-flex items-center gap-1 h-6 min-h-0 px-2.5 rounded-full bg-secondary-yellow/10 dark:bg-secondary-yellow/20 text-secondary-yellow dark:text-secondary-yellow border border-secondary-yellow/20 dark:border-secondary-yellow/30 text-xxs font-extrabold uppercase tracking-wider leading-none whitespace-nowrap">
                                                        Trễ {item.lateMins}p
                                                    </span>
                                                )}
                                                {item.isEarly && (
                                                    <span className="inline-flex items-center gap-1 h-6 min-h-0 px-2.5 rounded-full bg-secondary-yellow/10 dark:bg-secondary-yellow/20 text-secondary-yellow dark:text-secondary-yellow border border-secondary-yellow/20 dark:border-secondary-yellow/30 text-xxs font-extrabold uppercase tracking-wider leading-none whitespace-nowrap">
                                                        Sớm {item.earlyMins}p
                                                    </span>
                                                )}
                                                {item.status === 'Full' && !item.isLate && !item.isEarly && !item.isMissingCheckout && (
                                                    <span className="inline-flex items-center gap-1 h-6 min-h-0 px-2.5 rounded-full bg-primary/10 dark:bg-primary/20 text-primary dark:text-primary border border-primary/20 dark:border-primary/30 text-xxs font-extrabold uppercase tracking-wider leading-none whitespace-nowrap">
                                                        Đúng giờ
                                                    </span>
                                                )}
                                                {item.status === 'Half' && !item.isLate && !item.isEarly && !item.isMissingCheckout && (
                                                    <span className="inline-flex items-center gap-1 h-6 min-h-0 px-2.5 rounded-full bg-secondary-green/10 dark:bg-secondary-green/20 text-secondary-green dark:text-secondary-green border border-secondary-green/20 dark:border-secondary-green/30 text-xxs font-extrabold uppercase tracking-wider leading-none whitespace-nowrap">
                                                        Nửa ca
                                                    </span>
                                                )}

                                                {/* --- ACTION: GIẢI TRÌNH --- */}
                                                {(item.showExplain || item.explainStatus) && (
                                                    item.explainStatus === 'Approved' ? (
                                                        <span className="inline-flex items-center gap-1 h-6 min-h-0 px-2.5 rounded-full bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800 text-xxs font-extrabold uppercase tracking-wider leading-none whitespace-nowrap">
                                                            <span className="material-symbols-rounded text-xs leading-none">verified</span>
                                                            <span>Đã duyệt giải trình</span>
                                                        </span>
                                                    ) : item.explainStatus === 'Pending' ? (
                                                        <span className="inline-flex items-center gap-1 h-6 min-h-0 px-2.5 rounded-full bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400 border border-amber-200 dark:border-amber-800 text-xxs font-extrabold uppercase tracking-wider leading-none whitespace-nowrap">
                                                            <span className="material-symbols-rounded text-xs leading-none">schedule</span>
                                                            <span>Chờ duyệt</span>
                                                        </span>
                                                    ) : item.explainStatus === 'Rejected' ? (
                                                        <div className="flex items-center gap-1.5">
                                                            <span className="inline-flex items-center gap-1 h-6 min-h-0 px-2 rounded-full bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-400 border border-rose-200 dark:border-rose-800 text-xxs font-extrabold uppercase tracking-wider leading-none whitespace-nowrap">
                                                                <span className="material-symbols-rounded text-xs leading-none">cancel</span>
                                                                <span>Từ chối</span>
                                                            </span>
                                                            <button
                                                                type="button"
                                                                onClick={(e) => handleExplainClick(e, item.date, item.explainReason)}
                                                                className="inline-flex items-center gap-1 h-6 min-h-0 px-2 rounded-full bg-secondary-orange hover:bg-secondary-orange/90 text-white border border-secondary-orange/20 text-xxs font-extrabold active:scale-95 transition-all uppercase tracking-wider leading-none shadow-xs whitespace-nowrap cursor-pointer"
                                                            >
                                                                <span>Gửi lại</span>
                                                            </button>
                                                        </div>
                                                    ) : (
                                                        <button
                                                            type="button"
                                                            onClick={(e) => handleExplainClick(e, item.date, item.explainReason)}
                                                            className="inline-flex items-center gap-1 h-6 min-h-0 px-2.5 rounded-full bg-secondary-orange hover:bg-secondary-orange/90 text-white border border-secondary-orange/20 text-xxs font-extrabold active:scale-95 transition-all uppercase tracking-wider leading-none shadow-xs whitespace-nowrap cursor-pointer"
                                                        >
                                                            <span className="material-symbols-rounded text-xs leading-none">edit_document</span>
                                                            <span>Giải trình</span>
                                                        </button>
                                                    )
                                                )}
                                            </div>
                                        </div>

                                        {/* --- DÒNG THỜI GIAN (IN/OUT) --- */}
                                        {records.length > 0 && (
                                            <div className="space-y-2">
                                                {records.map((rec, rIdx) => (
                                                    <div key={rIdx} className="flex items-center justify-between bg-slate-50 dark:bg-dark-bg/50 rounded-xl p-3 px-4 border border-slate-100 dark:border-dark-border relative overflow-hidden">
                                                        <div className="flex flex-col z-10">
                                                            <span className="text-xxs font-extrabold text-slate-400 dark:text-dark-text-secondary uppercase tracking-widest mb-0.5">Vào {records.length > 1 ? rIdx + 1 : ''}</span>
                                                            <span className="text-base font-bold text-slate-800 dark:text-dark-text-primary font-mono">{rec.time_in}</span>
                                                        </div>

                                                        <div className="flex-1 flex items-center justify-center px-4 relative z-10">
                                                            <div className="w-2 h-2 rounded-full bg-slate-300 dark:bg-dark-text-secondary/50 flex-shrink-0"></div>
                                                            <div className={`flex-1 h-0.5 border-t-2 border-dashed mx-1.5 ${!rec.time_out ? 'border-secondary-red/30 dark:border-secondary-red/30' : 'border-slate-200 dark:border-dark-border'}`}></div>
                                                            <div className={`w-2 h-2 rounded-full flex-shrink-0 ${!rec.time_out ? 'bg-secondary-red dark:bg-secondary-red' : 'bg-slate-300 dark:bg-dark-text-secondary/50'}`}></div>
                                                        </div>

                                                        <div className="flex flex-col text-right z-10">
                                                            <span className="text-xxs font-extrabold text-slate-400 dark:text-dark-text-secondary uppercase tracking-widest mb-0.5">Ra {records.length > 1 ? rIdx + 1 : ''}</span>
                                                            <span className={`text-base font-bold font-mono ${!rec.time_out ? 'text-secondary-red dark:text-secondary-red' : 'text-slate-800 dark:text-dark-text-primary'}`}>
                                                                {rec.time_out || "--:--"}
                                                            </span>
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>

                                    {/* --- KHU VỰC MỞ RỘNG (CHI TIẾT ẨN) --- */}
                                    <AnimatePresence initial={false}>
                                        {isExpanded && (
                                            <motion.div
                                                initial={{ height: 0, opacity: 0 }}
                                                animate={{ height: 'auto', opacity: 1 }}
                                                exit={{ height: 0, opacity: 0 }}
                                                transition={{ duration: 0.2 }}
                                                className="overflow-hidden"
                                            >
                                                <div className="bg-slate-50/60 dark:bg-dark-bg/40 border-t border-slate-100 dark:border-dark-border">
                                                    {records.length > 0 && (
                                                        <div className="p-4 space-y-4">
                                                            {records.map((rec, rIdx) => (
                                                                <div key={rIdx} className="space-y-3 pb-3 border-b border-slate-100 dark:border-dark-border last:border-0 last:pb-0">
                                                                    <p className="text-xxs font-bold text-primary dark:text-primary uppercase tracking-widest">Lần chấm công {records.length > 1 ? rIdx + 1 : ''}</p>

                                                                    {(rec.center_id) && (
                                                                        <div className="flex items-center gap-3 text-xs">
                                                                            <div className="w-8 h-8 shrink-0 aspect-square rounded-full bg-slate-200/80 dark:bg-dark-border/60 flex items-center justify-center text-slate-500 dark:text-dark-text-secondary">
                                                                                <span className="material-symbols-rounded text-sm leading-none">location_on</span>
                                                                            </div>
                                                                            <div className="min-w-0">
                                                                                <p className="font-extrabold text-slate-400 dark:text-dark-text-secondary uppercase tracking-widest text-xxs mb-0.5">Trung tâm</p>
                                                                                <p className="font-bold text-slate-700 dark:text-dark-text-primary truncate">{locationsMap[rec.center_id] || rec.center_id}</p>
                                                                            </div>
                                                                        </div>
                                                                    )}
                                                                </div>
                                                            ))}
                                                        </div>
                                                    )}
                                                </div>
                                            </motion.div>
                                        )}
                                    </AnimatePresence>
                                </div>
                            )
                        })}
                    </div>
                )}
            </div>
        </PullToRefresh>
    );
};
export default TabHistory;
