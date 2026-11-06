import { useMemo, useState } from 'react';
import { TMS_LIMITS } from '@/shared/constants';
import type { AdminData } from '../types';
import { formatDateTime } from '../formatters';
import { EmptyState, Pagination, SearchField } from './AdminCommon';

function auditActionLabel(action: string) {
  const labels: Record<string, string> = {
    EMPLOYEE_CREATED: 'Tạo tài khoản',
    EMPLOYEE_UPDATED: 'Cập nhật tài khoản',
    TRUSTED_DEVICE_RESET: 'Thu hồi thiết bị',
    ATTENDANCE_REQUEST_SUBMITTED: 'Gửi yêu cầu công',
    ATTENDANCE_REQUEST_APPROVED: 'Duyệt yêu cầu công',
    ATTENDANCE_REQUEST_REJECTED: 'Từ chối yêu cầu công',
    TIMESHEETS_LOCKED: 'Khóa kỳ công',
    QR_STATION_UPDATED: 'Cập nhật trạm Kiosk',
    ADMIN_CONFIG_INSERT: 'Tạo cấu hình',
    ADMIN_CONFIG_UPDATE: 'Cập nhật cấu hình',
  };
  return labels[action] || action.split('_').join(' ').toLocaleLowerCase('vi');
}

export default function AuditSection({ data, loading }: { data: AdminData; loading: boolean }) {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const employeeNames = useMemo(() => new Map(data.employees.map((employee) => [employee.employee_id, employee.name])), [data.employees]);
  const logs = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase('vi');
    if (!normalizedQuery) return data.auditLogs;
    return data.auditLogs.filter((log) => [log.actor_employee_id, log.target_employee_id, log.action, log.entity_type, log.reason, employeeNames.get(log.actor_employee_id || ''), employeeNames.get(log.target_employee_id || '')].some((value) => String(value || '').toLocaleLowerCase('vi').includes(normalizedQuery)));
  }, [data.auditLogs, employeeNames, query]);
  const pageCount = Math.ceil(logs.length / TMS_LIMITS.ADMIN_TABLE_PAGE_SIZE);
  const safePage = Math.min(page, Math.max(pageCount, 1));
  const visibleLogs = logs.slice((safePage - 1) * TMS_LIMITS.ADMIN_TABLE_PAGE_SIZE, safePage * TMS_LIMITS.ADMIN_TABLE_PAGE_SIZE);

  return (
    <section className="admin-panel admin-audit-panel">
      <div className="admin-audit-toolbar"><SearchField value={query} onChange={(value) => { setQuery(value); setPage(1); }} placeholder="Người thao tác, hành động, đối tượng…" /><span>Hiển thị {data.auditLogs.length} hoạt động gần nhất</span></div>
      <div className="admin-audit-table" role="table" aria-label="Nhật ký quản trị">
        <div className="admin-audit-row admin-table-head" role="row"><span role="columnheader">Thời gian</span><span role="columnheader">Người thao tác</span><span role="columnheader">Hành động</span><span role="columnheader">Đối tượng</span><span role="columnheader">Chi tiết</span></div>
        {visibleLogs.map((log) => <article className="admin-audit-row" role="row" key={log.id}><span data-label="Thời gian" role="cell">{formatDateTime(log.created_at)}</span><span data-label="Người thao tác" role="cell"><strong>{employeeNames.get(log.actor_employee_id || '') || log.actor_employee_id || 'Hệ thống'}</strong></span><span data-label="Hành động" role="cell"><b>{auditActionLabel(log.action)}</b><small>{log.entity_type || '—'}</small></span><span data-label="Đối tượng" role="cell">{employeeNames.get(log.target_employee_id || '') || log.target_employee_id || log.entity_id || '—'}</span><span data-label="Chi tiết" role="cell" title={log.reason || ''}>{log.reason || '—'}</span></article>)}
        {!visibleLogs.length ? (
          loading
            ? <EmptyState icon="history" title="Đang tải nhật ký…" />
            : <EmptyState icon="history" title="Chưa có nhật ký phù hợp" />
        ) : null}
      </div>
      <Pagination page={safePage} pageCount={pageCount} onChange={setPage} summary={`${logs.length} hoạt động`} />
    </section>
  );
}
