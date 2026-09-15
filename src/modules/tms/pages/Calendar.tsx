import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { DashboardData, Employee, LeaveRequest } from '@/shared/types';
import { toISODateString, triggerHaptic } from '@/core/utils/helpers';
import PullToRefresh from '@/shared/components/layout/PullToRefresh';
import Avatar from '@/shared/components/common/Avatar';
import { buildLocationNameMap } from '@/modules/tms/services/locations';
import { getMySchedule, type WorkforceScheduleItem } from '@/modules/tms/services/schedule';
import { useSearchParams } from 'react-router-dom';

interface Props {
  data: DashboardData | null;
  user: Employee;
  onRefresh: () => Promise<boolean | void>;
  currentDate: Date;
}

type LeaveWithEmployee = LeaveRequest & { emp?: Employee };

const WEEKDAYS = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
const ALL_CENTERS = '__all__';

/** Leave types carry their own tone so a sick day never reads like a holiday. */
function leaveTone(type: string): string {
  if (type.includes('Nghỉ ốm')) return 'danger';
  if (type.includes('Nghỉ không lương')) return 'warning';
  if (type.includes('Làm việc tại nhà') || type.includes('WFH')) return 'success';
  if (type.includes('Công tác')) return 'info';
  if (type.includes('Nghỉ phép')) return 'primary';
  return 'muted';
}

const isRemote = (type: string) => type.includes('Làm việc tại nhà') || type.includes('WFH');
const isAnnualLeave = (type: string) => type.includes('Nghỉ phép');

const CalendarPage: React.FC<Props> = ({ data, user, onRefresh, currentDate }) => {
  const [searchParams, setSearchParams] = useSearchParams();
  const calendarView: 'mine' | 'team' = searchParams.get('calendarView') === 'team' ? 'team' : 'mine';
  const [viewDate, setViewDate] = useState<Date>(() => new Date(currentDate.getFullYear(), currentDate.getMonth(), 1));
  const [selectedDate, setSelectedDate] = useState<Date>(() => new Date(currentDate));
  const [activeCenter, setActiveCenter] = useState<string>(ALL_CENTERS);
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null);
  const [schedule, setSchedule] = useState<WorkforceScheduleItem[]>([]);
  const [scheduleLoading, setScheduleLoading] = useState(true);
  const [scheduleError, setScheduleError] = useState<string | null>(null);

  const monthRange = useMemo(() => ({
    from: toISODateString(new Date(viewDate.getFullYear(), viewDate.getMonth(), 1)),
    to: toISODateString(new Date(viewDate.getFullYear(), viewDate.getMonth() + 1, 0)),
  }), [viewDate]);

  const loadSchedule = useCallback(async () => {
    setScheduleLoading(true);
    setScheduleError(null);
    try {
      const result = await getMySchedule(monthRange.from, monthRange.to);
      setSchedule(result.items);
      return true;
    } catch (error) {
      setScheduleError(error instanceof Error ? error.message : 'Không tải được ca làm việc.');
      return false;
    } finally {
      setScheduleLoading(false);
    }
  }, [monthRange.from, monthRange.to]);

  useEffect(() => {
    void loadSchedule();
  }, [loadSchedule]);

  const refreshCalendar = useCallback(async () => {
    const [dashboardResult, scheduleResult] = await Promise.all([onRefresh(), loadSchedule()]);
    return Boolean(dashboardResult || scheduleResult);
  }, [loadSchedule, onRefresh]);

  const teamLeaves = useMemo(() => data?.teamLeaves || [], [data?.teamLeaves]);
  const contacts = useMemo(() => data?.contacts || [], [data?.contacts]);
  const locationsMap = useMemo(() => buildLocationNameMap(data), [data]);

  /** Everything on this screen reads from the same scoped set: the leaves this
   *  viewer is allowed to see. Scoping once keeps the month figures, the matrix
   *  badges and the day list from disagreeing with each other. */
  const visibleLeaves = useMemo<LeaveWithEmployee[]>(() => {
    const managed = new Set<string>(user.managed_locations || []);
    if (user.center_id) managed.add(user.center_id);
    const seesEveryone = user.role === 'Admin' || user.role === 'HR';

    return teamLeaves.reduce<LeaveWithEmployee[]>((rows, leave) => {
      const emp = contacts.find(c => c.employee_id === leave.employee_id);
      if (!emp || !emp.center_id) return rows;
      const isDirectReport = String(emp.direct_manager_id) === String(user.employee_id);
      if (seesEveryone || isDirectReport || managed.has(emp.center_id)) rows.push({ ...leave, emp });
      return rows;
    }, []);
  }, [teamLeaves, contacts, user]);

  const centerFiltered = useMemo(
    () => (activeCenter === ALL_CENTERS
      ? visibleLeaves
      : visibleLeaves.filter(l => l.emp?.center_id === activeCenter)),
    [visibleLeaves, activeCenter],
  );

  const leavesOn = useMemo(() => {
    const index = new Map<string, LeaveWithEmployee[]>();
    const cursor = new Date(viewDate.getFullYear(), viewDate.getMonth(), 1);
    const monthEnd = new Date(viewDate.getFullYear(), viewDate.getMonth() + 1, 0);
    while (cursor <= monthEnd) {
      const key = toISODateString(cursor);
      index.set(key, centerFiltered.filter(l => l.from_date <= key && l.to_date >= key));
      cursor.setDate(cursor.getDate() + 1);
    }
    return index;
  }, [centerFiltered, viewDate]);

  const scheduleOn = useMemo(() => {
    const index = new Map<string, WorkforceScheduleItem[]>();
    schedule.forEach((item) => {
      const rows = index.get(item.workDate) ?? [];
      rows.push(item);
      index.set(item.workDate, rows);
    });
    return index;
  }, [schedule]);

  /** Working days in the month after removing weekly off days and holidays —
   *  the denominator every absence figure on this screen is read against. */
  const standardWorkDays = useMemo(() => {
    const offDays = Array.isArray(data?.systemConfig?.OFF_DAYS) ? data.systemConfig.OFF_DAYS : [0];
    const holidays = data?.holidays || [];
    const year = viewDate.getFullYear();
    const month = viewDate.getMonth();
    const days = new Date(year, month + 1, 0).getDate();
    let count = 0;
    for (let day = 1; day <= days; day += 1) {
      const date = new Date(year, month, day);
      if (offDays.includes(date.getDay())) continue;
      const key = toISODateString(date);
      if (holidays.some(h => h.active !== false && key >= h.from_date && key <= h.to_date)) continue;
      count += 1;
    }
    return count;
  }, [viewDate, data?.systemConfig?.OFF_DAYS, data?.holidays]);

  const monthStats = useMemo(() => {
    const monthStart = toISODateString(new Date(viewDate.getFullYear(), viewDate.getMonth(), 1));
    const monthEnd = toISODateString(new Date(viewDate.getFullYear(), viewDate.getMonth() + 1, 0));
    const inMonth = centerFiltered.filter(l => l.from_date <= monthEnd && l.to_date >= monthStart);
    return {
      total: inMonth.length,
      remote: inMonth.filter(l => isRemote(l.type || '')).length,
      annual: inMonth.filter(l => isAnnualLeave(l.type || '')).length,
    };
  }, [centerFiltered, viewDate]);

  const myScheduleStats = useMemo(() => {
    const minutes = schedule.reduce((total, item) => {
      const [startHour = 0, startMinute = 0] = item.startTime.split(':').map(Number);
      const [endHour = 0, endMinute = 0] = item.endTime.split(':').map(Number);
      const start = startHour * 60 + startMinute;
      let end = endHour * 60 + endMinute;
      if (end <= start) end += 24 * 60;
      return total + Math.max(0, end - start);
    }, 0);
    return {
      shifts: schedule.length,
      hours: Math.round((minutes / 60) * 10) / 10,
      locations: new Set(schedule.map((item) => item.locationId || item.locationName).filter(Boolean)).size,
    };
  }, [schedule]);

  const calendarCells = useMemo(() => {
    const year = viewDate.getFullYear();
    const month = viewDate.getMonth();
    const leadingBlanks = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const cells: Array<Date | null> = Array.from({ length: leadingBlanks }, () => null);
    for (let day = 1; day <= daysInMonth; day += 1) cells.push(new Date(year, month, day));
    while (cells.length % 7 !== 0) cells.push(null);
    return cells;
  }, [viewDate]);

  const selectedKey = toISODateString(selectedDate);
  const selectedLeaves = useMemo(
    () => centerFiltered.filter(l => l.from_date <= selectedKey && l.to_date >= selectedKey),
    [centerFiltered, selectedKey],
  );
  const selectedSchedule = scheduleOn.get(selectedKey) ?? [];

  const centers = useMemo(() => {
    const ids = new Set<string>();
    visibleLeaves.forEach(l => { if (l.emp?.center_id) ids.add(l.emp.center_id); });
    return Array.from(ids).sort((a, b) => (locationsMap[a] || a).localeCompare(locationsMap[b] || b));
  }, [visibleLeaves, locationsMap]);

  const centerDayCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    visibleLeaves
      .filter(l => l.from_date <= selectedKey && l.to_date >= selectedKey)
      .forEach(l => {
        const id = l.emp?.center_id;
        if (id) counts[id] = (counts[id] || 0) + 1;
      });
    return counts;
  }, [visibleLeaves, selectedKey]);

  const groups = useMemo(() => {
    const byCenter = new Map<string, LeaveWithEmployee[]>();
    selectedLeaves.forEach(leave => {
      const centerId = leave.emp?.center_id || 'unknown';
      const bucket = byCenter.get(centerId) ?? [];
      bucket.push(leave);
      byCenter.set(centerId, bucket);
    });
    return Array.from(byCenter.entries())
      .map(([centerId, items]) => ({
        id: centerId,
        title: locationsMap[centerId] || centerId,
        code: centerId,
        address: data?.locations?.find(l => l.center_id === centerId)?.address || '',
        items,
      }))
      .sort((a, b) => a.title.localeCompare(b.title));
  }, [selectedLeaves, locationsMap, data?.locations]);

  useEffect(() => {
    setExpandedGroup(prev => (prev && groups.some(g => g.id === prev) ? prev : groups[0]?.id || null));
  }, [groups]);

  const today = new Date();
  const todayKey = toISODateString(today);
  const isCurrentMonth = viewDate.getFullYear() === today.getFullYear() && viewDate.getMonth() === today.getMonth();

  const shiftMonth = (delta: number) => {
    triggerHaptic('light');
    const nextMonth = new Date(viewDate.getFullYear(), viewDate.getMonth() + delta, 1);
    const selectedDay = Math.min(selectedDate.getDate(), new Date(nextMonth.getFullYear(), nextMonth.getMonth() + 1, 0).getDate());
    setViewDate(nextMonth);
    setSelectedDate(new Date(nextMonth.getFullYear(), nextMonth.getMonth(), selectedDay));
  };

  const jumpToToday = () => {
    triggerHaptic('light');
    setViewDate(new Date(today.getFullYear(), today.getMonth(), 1));
    setSelectedDate(new Date(today));
  };

  const selectCalendarView = (view: 'mine' | 'team') => {
    triggerHaptic('light');
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      if (view === 'mine') next.delete('calendarView');
      else next.set('calendarView', view);
      return next;
    });
  };

  const handleCalendarTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const nextView = event.key === 'ArrowRight' || event.key === 'End' ? 'team' : 'mine';
    selectCalendarView(nextView);
    window.requestAnimationFrame(() => document.getElementById(`calendar-tab-${nextView}`)?.focus());
  };

  const selectedLabel = selectedKey === todayKey
    ? 'Hôm nay'
    : `${WEEKDAYS[selectedDate.getDay()]}, ${selectedDate.getDate()}/${selectedDate.getMonth() + 1}`;

  return (
    <PullToRefresh onRefresh={refreshCalendar} className="page-bg font-sans">
      <div className="employee-page employee-page-standard calendar-page animate-fade-in ui-stack">

        <div className="requests-switch" role="tablist" aria-label="Chế độ lịch làm việc">
          <button
            type="button"
            role="tab"
            id="calendar-tab-mine"
            aria-selected={calendarView === 'mine'}
            aria-controls="calendar-panel"
            tabIndex={calendarView === 'mine' ? 0 : -1}
            className={`requests-switch-option ${calendarView === 'mine' ? 'requests-switch-option-active' : ''}`.trim()}
            onClick={() => selectCalendarView('mine')}
            onKeyDown={handleCalendarTabKeyDown}
          >
            <span className="material-symbols-rounded" aria-hidden="true">badge</span>
            <span className="requests-switch-text">
              <span className="requests-switch-label">Ca của tôi</span>
              <span className="requests-switch-sub">Lịch đã công bố</span>
            </span>
            <span className="ui-pill ui-pill-muted">{schedule.length}</span>
          </button>
          <button
            type="button"
            role="tab"
            id="calendar-tab-team"
            aria-selected={calendarView === 'team'}
            aria-controls="calendar-panel"
            tabIndex={calendarView === 'team' ? 0 : -1}
            className={`requests-switch-option ${calendarView === 'team' ? 'requests-switch-option-active' : ''}`.trim()}
            onClick={() => selectCalendarView('team')}
            onKeyDown={handleCalendarTabKeyDown}
          >
            <span className="material-symbols-rounded" aria-hidden="true">groups</span>
            <span className="requests-switch-text">
              <span className="requests-switch-label">Vắng mặt team</span>
              <span className="requests-switch-sub">Theo quyền xem</span>
            </span>
            <span className="ui-pill ui-pill-muted">{visibleLeaves.length}</span>
          </button>
        </div>

        <div id="calendar-panel" role="tabpanel" aria-labelledby={calendarView === 'mine' ? 'calendar-tab-mine' : 'calendar-tab-team'} className="contents">
          <p className="sr-only" role="status" aria-live="polite">
            {scheduleLoading ? 'Đang tải ca của tôi.' : scheduleError || `Đã tải ${schedule.length} ca của tôi.`}
          </p>

        {/* Period ------------------------------------------------------- */}
        <section className="ui-card">
          <div className="ui-card-head">
            <span className="ui-tile ui-tone-primary" aria-hidden="true">
              <span className="material-symbols-rounded">calendar_month</span>
            </span>
            <span className="ui-card-head-text">
              <span className="ui-card-head-title">
                Tháng {viewDate.getMonth() + 1}, {viewDate.getFullYear()}
              </span>
              <span className="ui-card-head-sub">
                Quý {Math.floor(viewDate.getMonth() / 3) + 1} • {standardWorkDays} ngày công chuẩn
              </span>
            </span>
            <div className="app-period-control">
              <button type="button" className="app-period-button" aria-label="Tháng trước" onClick={() => shiftMonth(-1)}>
                <span className="material-symbols-rounded" aria-hidden="true">chevron_left</span>
              </button>
              <button type="button" className="app-period-label calendar-today-button" onClick={jumpToToday}>
                Hôm nay
              </button>
              <button type="button" className="app-period-button" aria-label="Tháng sau" onClick={() => shiftMonth(1)}>
                <span className="material-symbols-rounded" aria-hidden="true">chevron_right</span>
              </button>
            </div>
          </div>

          <div className="ui-card-section ui-stat-strip">
            <div className="ui-stat">
              <span className="ui-stat-value">{calendarView === 'mine' ? myScheduleStats.shifts : monthStats.total}<span className="ui-stat-unit">{calendarView === 'mine' ? 'ca' : 'lượt'}</span></span>
              <span className="ui-stat-label">{calendarView === 'mine' ? 'Ca đã xếp' : 'Tổng vắng team'}</span>
            </div>
            <div className="ui-stat">
              <span className="ui-stat-value">{calendarView === 'mine' ? myScheduleStats.hours : monthStats.remote}<span className="ui-stat-unit">{calendarView === 'mine' ? 'giờ' : 'lượt'}</span></span>
              <span className="ui-stat-label">{calendarView === 'mine' ? 'Thời lượng' : 'Làm từ xa'}</span>
            </div>
            <div className="ui-stat">
              <span className="ui-stat-value">{calendarView === 'mine' ? myScheduleStats.locations : monthStats.annual}<span className="ui-stat-unit">{calendarView === 'mine' ? 'nơi' : 'lượt'}</span></span>
              <span className="ui-stat-label">{calendarView === 'mine' ? 'Địa điểm' : 'Nghỉ phép năm'}</span>
            </div>
          </div>
        </section>

        {/* Matrix ------------------------------------------------------- */}
        <section className="ui-card ui-card-pad">
          <div className="ui-cal" role="grid" aria-label={`Lịch tháng ${viewDate.getMonth() + 1}`}>
            <div role="row" className="ui-cal-row">
              {WEEKDAYS.map((label, index) => (
                <div role="columnheader" key={label} className={`ui-cal-head ${index === 0 ? 'ui-cal-head-sun' : ''}`.trim()}>{label}</div>
              ))}
            </div>
            {Array.from({ length: calendarCells.length / 7 }, (_, weekIndex) => (
              <div role="row" className="ui-cal-row" key={`week-${weekIndex}`}>
                {calendarCells.slice(weekIndex * 7, weekIndex * 7 + 7).map((date, dayIndex) => {
                  const index = weekIndex * 7 + dayIndex;
                  if (!date) return <div role="gridcell" key={`blank-${index}`} className="ui-cal-cell"><span className="ui-cal-day ui-cal-day-blank" aria-hidden="true" /></div>;
                  const key = toISODateString(date);
                  const count = calendarView === 'mine'
                    ? scheduleOn.get(key)?.length ?? 0
                    : leavesOn.get(key)?.length ?? 0;
                  const isSelected = key === selectedKey;
                  const classes = [
                    'ui-cal-day',
                    date.getDay() === 0 && !isSelected ? 'ui-cal-day-sun' : '',
                    key === todayKey && !isSelected ? 'ui-cal-day-today' : '',
                    isSelected ? 'ui-cal-day-selected' : '',
                  ].filter(Boolean).join(' ');
                  const countLabel = calendarView === 'mine' ? `${count} ca làm việc` : `${count} nhân sự vắng`;

                  return (
                    <div role="gridcell" key={key} className="ui-cal-cell">
                      <button
                        type="button"
                        aria-pressed={isSelected}
                        aria-label={`Ngày ${date.getDate()}/${date.getMonth() + 1}: ${countLabel}`}
                        className={classes}
                        onClick={() => { triggerHaptic('light'); setSelectedDate(date); }}
                      >
                        <span>{date.getDate()}</span>
                        {count > 0 ? <span className="ui-cal-badge">+{count}</span> : null}
                      </button>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>

          <div className="ui-legend calendar-legend">
            <span className="ui-legend-item"><span className="ui-legend-dot ui-tone-primary" aria-hidden="true" />Đang chọn</span>
            <span className="ui-legend-item"><span className="ui-legend-dot ui-tone-success" aria-hidden="true" />{calendarView === 'mine' ? 'Có ca làm việc' : 'Có nhân sự nghỉ'}</span>
            <span className="ui-legend-item"><span className="ui-legend-dot ui-tone-danger" aria-hidden="true" />Ngày nghỉ tuần</span>
          </div>
        </section>

        {calendarView === 'team' && centers.length > 1 && (
          <div className="ui-chips">
            <button
              type="button"
              aria-pressed={activeCenter === ALL_CENTERS}
              className={`ui-chip ${activeCenter === ALL_CENTERS ? 'ui-chip-active' : ''}`.trim()}
              onClick={() => { triggerHaptic('light'); setActiveCenter(ALL_CENTERS); }}
            >
              <span>Tất cả</span>
              <span className="ui-chip-count">{Object.values(centerDayCounts).reduce((a, b) => a + b, 0)}</span>
            </button>
            {centers.map(centerId => (
              <button
                key={centerId}
                type="button"
                aria-pressed={activeCenter === centerId}
                className={`ui-chip ${activeCenter === centerId ? 'ui-chip-active' : ''}`.trim()}
                onClick={() => { triggerHaptic('light'); setActiveCenter(centerId); }}
              >
                <span className="ui-chip-dot" aria-hidden="true" />
                <span>{locationsMap[centerId] || centerId}</span>
                <span className="ui-chip-count">{centerDayCounts[centerId] ?? 0}</span>
              </button>
            ))}
          </div>
        )}

        {calendarView === 'mine' ? (
          <section aria-labelledby="my-schedule-day-title">
            <div className="ui-label-row">
              <span id="my-schedule-day-title" className="ui-label">Ca của tôi · {selectedLabel}</span>
              <span className="ui-pill ui-pill-primary">{selectedSchedule.length} ca</span>
            </div>

            {scheduleError ? (
              <div className="ui-empty" role="alert">
                <span className="material-symbols-rounded" aria-hidden="true">event_busy</span>
                <span className="ui-empty-title">Chưa tải được lịch</span>
                <span className="ui-empty-text">{scheduleError}</span>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => void loadSchedule()}>Thử lại</button>
              </div>
            ) : scheduleLoading ? (
              <div className="ui-empty" role="status">
                <span className="material-symbols-rounded ui-spin" aria-hidden="true">progress_activity</span>
                <span className="ui-empty-title">Đang tải ca làm việc…</span>
              </div>
            ) : selectedSchedule.length === 0 ? (
              <div className="ui-empty">
                <span className="material-symbols-rounded" aria-hidden="true">event_available</span>
                <span className="ui-empty-title">Chưa có ca được công bố</span>
                <span className="ui-empty-text">Kéo xuống để làm mới khi quản lý cập nhật lịch.</span>
              </div>
            ) : (
              <div className="ui-stack">
                {selectedSchedule.map((item) => (
                  <article className="ui-card" key={item.id}>
                    <div className="ui-card-head">
                      <span className="ui-tile ui-tone-primary" aria-hidden="true">
                        <span className="material-symbols-rounded">work_history</span>
                      </span>
                      <span className="ui-card-head-text">
                        <span className="ui-card-head-title">{item.shiftName}</span>
                        <span className="ui-card-head-sub">{item.startTime.slice(0, 5)} – {item.endTime.slice(0, 5)}</span>
                      </span>
                      <span className="ui-pill ui-pill-success">Đã công bố</span>
                    </div>
                    {(item.locationName || item.locationId || item.note) ? (
                      <div className="ui-card-section">
                        <div className="ui-note calendar-shift-note">
                          <span className="material-symbols-rounded" aria-hidden="true">location_on</span>
                          {[item.locationName || item.locationId, item.note].filter(Boolean).join(' • ')}
                        </div>
                      </div>
                    ) : null}
                  </article>
                ))}
              </div>
            )}
          </section>
        ) : (
        <section aria-labelledby="team-absence-day-title">
          <div className="ui-label-row">
            <span id="team-absence-day-title" className="ui-label">Danh sách vắng mặt · {selectedLabel}</span>
            <span className="ui-pill ui-pill-primary">{selectedLeaves.length} nhân sự</span>
          </div>

          {groups.length === 0 ? (
            <div className="ui-empty">
              <span className="material-symbols-rounded" aria-hidden="true">event_available</span>
              <span className="ui-empty-title">Không có nhân sự vắng</span>
              <span className="ui-empty-text">Toàn bộ đội ngũ đi làm trong ngày này.</span>
            </div>
          ) : (
            <div className="ui-stack">
              {groups.map(group => {
                const isExpanded = expandedGroup === group.id;
                return (
                  <div key={group.id} className="ui-card">
                    <button
                      type="button"
                      className="ui-card-head"
                      aria-expanded={isExpanded}
                      onClick={() => { triggerHaptic('light'); setExpandedGroup(prev => prev === group.id ? null : group.id); }}
                    >
                      <span className="ui-tile ui-tone-primary" aria-hidden="true">
                        <span className="material-symbols-rounded">apartment</span>
                      </span>
                      <span className="ui-card-head-text">
                        <span className="ui-card-head-title">{group.title}</span>
                        <span className="ui-card-head-sub">{group.address || group.code}</span>
                      </span>
                      <span className="ui-pill ui-pill-muted">{group.items.length} người</span>
                      <span className={`ui-card-head-chevron material-symbols-rounded ${isExpanded ? 'ui-card-head-chevron-open' : ''}`.trim()} aria-hidden="true">expand_more</span>
                    </button>

                    <AnimatePresence initial={false}>
                      {isExpanded && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: 'auto', opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.2 }}
                          className="overflow-hidden"
                        >
                          <div className="ui-card-section">
                            {group.items.map(item => {
                              const name = item.name || item.emp?.name || item.employee_id;
                              const tone = leaveTone(item.type || '');
                              return (
                                <div key={item.id} className="ui-person">
                                  <span className="ui-person-figure">
                                    <Avatar src={item.emp?.face_ref_url} name={name} className="w-11 h-11 rounded-2xl" textSize="text-xs" />
                                    <span className="ui-person-dot ui-person-dot-away" aria-hidden="true" />
                                  </span>
                                  <span className="ui-person-body">
                                    <span className="ui-person-name">{name}</span>
                                    <span className="ui-person-meta">
                                      {item.emp?.department ? <span>{item.emp.department}</span> : null}
                                      {item.emp?.department && item.emp?.position ? <span aria-hidden="true">•</span> : null}
                                      {item.emp?.position ? <span>{item.emp.position}</span> : null}
                                    </span>
                                  </span>
                                  <span className={`ui-pill ui-pill-${tone}`}>{item.type}</span>
                                </div>
                              );
                            })}
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                );
              })}
            </div>
          )}
        </section>
        )}

        <p className="ui-note">
          <span className="material-symbols-rounded" aria-hidden="true">info</span>
          {calendarView === 'mine'
            ? 'Chạm vào từng ngày để xem ca làm việc đã được công bố cho bạn.'
            : 'Chạm vào từng ngày để xem nhân sự vắng mặt và loại đơn đã được duyệt.'}
          {!isCurrentMonth ? ' Bạn đang xem một tháng khác — chạm “Hôm nay” để quay lại.' : ''}
        </p>
        </div>
      </div>
    </PullToRefresh>
  );
};

export default CalendarPage;
