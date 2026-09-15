import { Suspense, lazy } from 'react';
import type { AdminData } from '../types';
import type { AdminSection } from '../constants';
import { formatClock, formatStatus } from '../formatters';
import { EmptyState, PanelTitle } from './AdminCommon';
import { TMS_LIMITS } from '@/shared/constants';
import Avatar from '@/shared/components/common/Avatar';

const ExplanationAnalytics = lazy(() => import('./ExplanationAnalytics'));

export default function OverviewSection({
  data,
  today,
  allowedSections,
  onNavigate,
}: {
  data: AdminData;
  today: string;
  allowedSections: ReadonlySet<AdminSection>;
  onNavigate: (section: AdminSection) => void;
}) {
  const canOpenAttendance = allowedSections.has('attendance');
  const canOpenScheduling = allowedSections.has('scheduling');
  const canOpenKiosks = allowedSections.has('kiosks');
  const hasOperationalShortcut = canOpenAttendance || canOpenScheduling || canOpenKiosks;
  const activeEmployees = data.employees.filter((employee) => employee.status === 'Active' && employee.role !== 'Kiosk');
  const todayTimesheets = data.timesheets.filter((timesheet) => timesheet.work_date === today);
  const checkedIn = todayTimesheets.filter((timesheet) => timesheet.actual_checkin).length;
  const working = todayTimesheets.filter((timesheet) => timesheet.actual_checkin && !timesheet.actual_checkout).length;
  const exceptions = todayTimesheets.filter((timesheet) => timesheet.status === 'EXCEPTION' || timesheet.status === 'REJECTED').length;
  const employees = new Map(data.employees.map((employee) => [employee.employee_id, employee]));
  const employeeNames = new Map(data.employees.map((employee) => [employee.employee_id, employee.name]));
  const actionStatuses = new Set(['OPEN', 'EXCEPTION', 'PENDING_REVIEW', 'REJECTED']);
  const unresolvedTimesheets = data.timesheets.filter((timesheet) => actionStatuses.has(timesheet.status)).length;
  const resolvedTimesheets = data.timesheets.length - unresolvedTimesheets;
  const dataQuality = data.timesheets.length ? Math.round((resolvedTimesheets / data.timesheets.length) * 100) : 100;
  const onlineKiosks = data.stations.filter((station) => station.active && Date.now() - new Date(station.updated_at || 0).getTime() <= TMS_LIMITS.KIOSK_ONLINE_WINDOW_MS).length;
  const activeKiosks = data.stations.filter((station) => station.active).length;
  const scheduledEmployees = new Set(data.shiftAssignments.filter((assignment) => assignment.work_date >= today).map((assignment) => assignment.employee_id)).size;
  const locationStats = [...data.timesheets.reduce((stats, timesheet) => {
    const key = timesheet.location_id || 'Chưa xác định';
    const current = stats.get(key) || { total: 0, exceptions: 0 };
    current.total += 1;
    if (actionStatuses.has(timesheet.status)) current.exceptions += 1;
    stats.set(key, current);
    return stats;
  }, new Map<string, { total: number; exceptions: number }>()).entries()]
    .sort(([, left], [, right]) => right.total - left.total)
    .slice(0, 5);

  const metrics = [
    { icon: 'login', label: 'Đã đến hôm nay', value: `${checkedIn}/${activeEmployees.length}`, tone: 'primary' },
    { icon: 'work_history', label: 'Đang làm việc', value: working, tone: 'success' },
    { icon: 'warning', label: 'Ngoại lệ hôm nay', value: exceptions, tone: exceptions ? 'warning' : 'neutral' },
    { icon: 'approval', label: 'Yêu cầu chờ duyệt', value: data.requests.length, tone: data.requests.length ? 'danger' : 'neutral' },
  ];

  return (
    <div className="admin-section-stack">
      <section className="admin-kpi-grid" aria-label="Tổng quan chấm công hôm nay">
        {metrics.map((metric) => (
          <article className={`admin-kpi admin-kpi-${metric.tone}`} key={metric.label}>
            <span className="material-symbols-rounded" aria-hidden="true">{metric.icon}</span>
            <div><small>{metric.label}</small><strong>{metric.value}</strong></div>
          </article>
        ))}
      </section>

      <div className="admin-dashboard-grid">
        <section className="admin-panel">
          <PanelTitle
            eyebrow="Theo thời gian thực"
            title="Tình hình hôm nay"
            action={canOpenAttendance ? <button type="button" className="admin-text-button" onClick={() => onNavigate('attendance')}>Xem bảng công</button> : undefined}
          />
          <div className="admin-activity-list">
            {todayTimesheets.slice(0, 10).map((timesheet) => (
              <article className="admin-activity" key={timesheet.id}>
                <Avatar src={employees.get(timesheet.employee_id)?.avatar_url || employees.get(timesheet.employee_id)?.face_ref_url} name={employeeNames.get(timesheet.employee_id) || timesheet.employee_id} className="admin-avatar" textSize="" />
                <div>
                  <strong>{employeeNames.get(timesheet.employee_id) || timesheet.employee_id}</strong>
                  <small>{timesheet.location_id || 'Chưa có địa điểm'} · {formatClock(timesheet.actual_checkin)} → {formatClock(timesheet.actual_checkout)}</small>
                </div>
                <span className={`admin-status status-${timesheet.status.toLowerCase()}`}>{formatStatus(timesheet.status)}</span>
              </article>
            ))}
            {!todayTimesheets.length ? <EmptyState icon="schedule" title="Chưa có timesheet hôm nay" /> : null}
          </div>
        </section>

        <section className="admin-panel">
          <PanelTitle
            eyebrow="Hàng chờ xử lý"
            title="Cần quyết định"
            action={canOpenAttendance ? <button type="button" className="admin-text-button" onClick={() => onNavigate('attendance')}>Mở hàng chờ</button> : undefined}
          />
          <div className="admin-activity-list">
            {data.requests.slice(0, 7).map((request) => (
              <article className="admin-activity compact" key={request.id}>
                <span className="admin-activity-icon material-symbols-rounded" aria-hidden="true">edit_note</span>
                <div>
                  <strong>{employeeNames.get(request.employee_id) || request.employee_id}</strong>
                  <small>{request.request_type === 'CORRECTION' ? 'Điều chỉnh giờ' : 'Giải trình'} · {request.reason}</small>
                </div>
              </article>
            ))}
            {!data.requests.length ? <EmptyState icon="verified" title="Không có yêu cầu chờ duyệt" /> : null}
          </div>
        </section>
      </div>

      {/* Biểu đồ thống kê đơn giải trình (Pending vs Approved/Rejected) trong tháng.
          Charting pulls in the single heaviest dependency in the bundle, and this
          is the section the Control Center opens on, so it is split off and the
          numbers above it paint first. */}
      <Suspense fallback={<div className="admin-panel admin-chart-placeholder" aria-hidden="true" />}>
        <ExplanationAnalytics
          requests={data.requests}
          monthlyRequests={data.monthlyRequests}
          onNavigate={canOpenAttendance ? onNavigate : undefined}
        />
      </Suspense>

      <div className="admin-dashboard-grid admin-insight-grid">
        <section className="admin-panel">
          <PanelTitle eyebrow="Chất lượng dữ liệu tháng" title="Mức sẵn sàng chốt công" action={<strong className={`admin-quality-score ${dataQuality < 100 ? 'attention' : ''}`}>{dataQuality}%</strong>} />
          <div className="admin-progress-list">
            {locationStats.map(([location, stats]) => {
              const quality = Math.round(((stats.total - stats.exceptions) / stats.total) * 100);
              return <div className="admin-progress-row" key={location}><span><strong>{location}</strong><small>{stats.exceptions ? `${stats.exceptions} ngày cần xử lý` : 'Dữ liệu đã sạch'}</small></span><div><i style={{ '--progress-value': `${quality}%` } as React.CSSProperties} /></div><b>{quality}%</b></div>;
            })}
            {!locationStats.length ? <EmptyState icon="monitoring" title="Chưa có dữ liệu để phân tích" /> : null}
          </div>
        </section>

        {hasOperationalShortcut ? <section className="admin-panel">
          <PanelTitle eyebrow="Nhắc việc vận hành" title="Việc cần ưu tiên" />
          <div className="admin-operation-list">
            {canOpenAttendance ? <button type="button" onClick={() => onNavigate('attendance')}><span className={`admin-activity-icon material-symbols-rounded ${data.requests.length ? 'attention' : ''}`}>approval</span><span><strong>Duyệt yêu cầu chấm công</strong><small>{data.requests.length ? `${data.requests.length} yêu cầu đang chờ` : 'Hàng chờ đã sạch'}</small></span><b>{data.requests.length}</b></button> : null}
            {canOpenScheduling ? <button type="button" onClick={() => onNavigate('scheduling')}><span className="admin-activity-icon material-symbols-rounded">calendar_month</span><span><strong>Phân ca sắp tới</strong><small>{scheduledEmployees ? `${scheduledEmployees} nhân viên đã có lịch` : 'Chưa có lịch tương lai'}</small></span><b>{scheduledEmployees}</b></button> : null}
            {canOpenKiosks ? <button type="button" onClick={() => onNavigate('kiosks')}><span className={`admin-activity-icon material-symbols-rounded ${activeKiosks > onlineKiosks ? 'attention' : ''}`}>desktop_windows</span><span><strong>Sức khỏe Kiosk</strong><small>{onlineKiosks}/{activeKiosks} trạm hoạt động đang online</small></span><b>{Math.max(0, activeKiosks - onlineKiosks)}</b></button> : null}
          </div>
        </section> : null}
      </div>
    </div>
  );
}
