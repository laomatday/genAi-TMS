import { useEffect, useMemo, useRef, useState } from 'react';
import ConfirmDialog from '@/shared/components/modals/ConfirmDialog';
import { ADMIN_BULK_NOTE_PRESETS, TMS_LIMITS } from '@/shared/constants';
import { ATTENDANCE_STATUS_LABELS, type AttendanceFilter } from '../constants';
import { exportAttendanceExcel, exportPayrollExcel } from '../exportAttendance';
import { formatClock, formatDate, formatExceptions, formatHours, formatStatus, monthRange } from '../formatters';
import { closeAttendancePeriod, reviewAttendanceRequest, reviewAttendanceRequestsBulk } from '../adminService';
import type { AdminActionRunner, AdminData, AttendanceRequest } from '../types';
import { EmptyState, Pagination, SearchField } from './AdminCommon';

const attendanceTabs: ReadonlyArray<{ id: AttendanceFilter; label: string }> = [
  { id: 'all', label: 'Tất cả' },
  { id: 'action', label: 'Cần xử lý' },
  { id: 'approved', label: 'Đã duyệt' },
  { id: 'locked', label: 'Đã khóa' },
];

export default function AttendanceSection({
  data,
  month,
  onMonthChange,
  busy,
  canReview,
  canExport,
  canLock,
  onRun,
}: {
  data: AdminData;
  month: string;
  onMonthChange: (month: string) => void;
  busy: boolean;
  canReview: boolean;
  canExport: boolean;
  canLock: boolean;
  onRun: AdminActionRunner;
}) {
  const [filter, setFilter] = useState<AttendanceFilter>('all');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({});
  const [selectedRequestIds, setSelectedRequestIds] = useState<string[]>([]);
  const [bulkStatus, setBulkStatus] = useState<'APPROVED' | 'REJECTED' | null>(null);
  const [bulkNote, setBulkNote] = useState('');
  const [requestFilter, setRequestFilter] = useState<'ALL' | 'EXPLANATION' | 'CORRECTION'>('ALL');
  const [confirmClose, setConfirmClose] = useState(false);
  const [closeNote, setCloseNote] = useState('');
  const masterCheckboxRef = useRef<HTMLInputElement>(null);

  const employeeNames = useMemo(() => new Map(data.employees.map((employee) => [employee.employee_id, employee.name])), [data.employees]);
  const timesheetsById = useMemo(() => new Map(data.timesheets.map((timesheet) => [timesheet.id, timesheet])), [data.timesheets]);
  
  const explanationRequests = useMemo(() => data.requests.filter((request) => request.request_type === 'EXPLANATION'), [data.requests]);
  const correctionRequests = useMemo(() => data.requests.filter((request) => request.request_type === 'CORRECTION'), [data.requests]);

  const displayedRequests = useMemo(() => {
    if (requestFilter === 'EXPLANATION') return explanationRequests;
    if (requestFilter === 'CORRECTION') return correctionRequests;
    return data.requests;
  }, [data.requests, requestFilter, explanationRequests, correctionRequests]);

  const bulkCandidates = useMemo(() => displayedRequests.slice(0, TMS_LIMITS.ADMIN_BULK_REVIEW_LIMIT), [displayedRequests]);
  const isAllSelected = bulkCandidates.length > 0 && bulkCandidates.every((request) => selectedRequestIds.includes(request.id));
  const isSomeSelected = bulkCandidates.some((request) => selectedRequestIds.includes(request.id)) && !isAllSelected;

  useEffect(() => {
    if (masterCheckboxRef.current) {
      masterCheckboxRef.current.indeterminate = isSomeSelected;
    }
  }, [isSomeSelected]);

  useEffect(() => {
    if (!canReview && filter === 'action') setFilter('all');
  }, [canReview, filter]);

  const selectedRequests = useMemo(
    () => data.requests.filter((request) => selectedRequestIds.includes(request.id)),
    [data.requests, selectedRequestIds],
  );

  const range = useMemo(() => monthRange(month), [month]);
  const currentPeriod = data.attendancePeriods.find((period) => period.period_start === range.from && period.period_end === range.to);
  const periodClosed = currentPeriod?.status === 'CLOSED';
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

  useEffect(() => {
    const availableIds = new Set(data.requests.map((request) => request.id));
    setSelectedRequestIds((current) => current.filter((id) => availableIds.has(id)));
  }, [data.requests]);

  const toggleSelectAll = () => {
    if (isAllSelected) {
      const candidateIds = new Set(bulkCandidates.map((request) => request.id));
      setSelectedRequestIds((current) => current.filter((id) => !candidateIds.has(id)));
    } else {
      const candidateIds = bulkCandidates.map((request) => request.id);
      setSelectedRequestIds((current) => [...new Set([...current, ...candidateIds])]);
    }
  };

  const filteredTimesheets = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase('vi');
    return data.timesheets.filter((timesheet) => {
      if (filter === 'action' && !['EXCEPTION', 'REJECTED', 'PENDING_REVIEW'].includes(timesheet.status)) return false;
      if (filter === 'approved' && !['AUTO_APPROVED', 'APPROVED', 'COMPLETE'].includes(timesheet.status)) return false;
      if (filter === 'locked' && timesheet.status !== 'LOCKED') return false;
      if (!normalizedQuery) return true;
      return [timesheet.employee_id, employeeNames.get(timesheet.employee_id), timesheet.location_id, formatStatus(timesheet.status)]
        .some((value) => String(value || '').toLocaleLowerCase('vi').includes(normalizedQuery));
    });
  }, [data.timesheets, employeeNames, filter, query]);

  const pageCount = Math.ceil(filteredTimesheets.length / TMS_LIMITS.ADMIN_TABLE_PAGE_SIZE);
  const safePage = Math.min(page, Math.max(pageCount, 1));
  const visibleTimesheets = filteredTimesheets.slice(
    (safePage - 1) * TMS_LIMITS.ADMIN_TABLE_PAGE_SIZE,
    safePage * TMS_LIMITS.ADMIN_TABLE_PAGE_SIZE,
  );
  const uniqueEmployees = new Set(data.timesheets.map((timesheet) => timesheet.employee_id)).size;
  const totalWorkMinutes = data.timesheets.reduce((total, timesheet) => total + (timesheet.work_minutes || 0), 0);
  const totalLateMinutes = data.timesheets.reduce((total, timesheet) => total + (timesheet.late_minutes || 0), 0);
  const exceptionCount = data.timesheets.filter((timesheet) => ['EXCEPTION', 'REJECTED', 'PENDING_REVIEW'].includes(timesheet.status)).length;
  const unresolvedPeriodCount = data.timesheets.filter((timesheet) => ['OPEN', 'EXCEPTION', 'REJECTED', 'PENDING_REVIEW'].includes(timesheet.status)).length;

  const review = async (request: AttendanceRequest, status: 'APPROVED' | 'REJECTED') => {
    if (!canReview) return;
    await onRun(
      () => reviewAttendanceRequest(request, status, reviewNotes[request.id] || ''),
      status === 'APPROVED' ? 'Đã duyệt và cập nhật ngày công.' : 'Đã từ chối yêu cầu.',
    );
  };

  const reviewBulk = async () => {
    if (!canReview || !bulkStatus || !selectedRequests.length) return;
    const requests = [...selectedRequests];
    const status = bulkStatus;
    const note = bulkNote;
    setBulkStatus(null);
    setSelectedRequestIds([]);
    setBulkNote('');
    await onRun(
      () => reviewAttendanceRequestsBulk(requests, status, note),
      status === 'APPROVED' ? `Đã duyệt hàng loạt ${requests.length} yêu cầu.` : `Đã từ chối hàng loạt ${requests.length} yêu cầu.`,
    );
  };

  const confirmPeriodClose = async () => {
    if (!canLock) return;
    setConfirmClose(false);
    await onRun(
      () => closeAttendancePeriod(range, closeNote),
      `Đã đóng kỳ công tháng ${month} và khóa dữ liệu payroll.`,
    );
    setCloseNote('');
  };

  return (
    <div className="admin-section-stack">
      <section className="admin-summary-strip">
        <article><small>Nhân sự có dữ liệu</small><strong>{uniqueEmployees}</strong></article>
        <article><small>Tổng giờ công</small><strong>{formatHours(totalWorkMinutes)}</strong></article>
        <article><small>Tổng phút đi trễ</small><strong>{totalLateMinutes}</strong></article>
        <article className={exceptionCount ? 'attention' : ''}><small>Ngoại lệ</small><strong>{exceptionCount}</strong></article>
      </section>

      {canReview && data.requests.length > 0 && filter !== 'action' ? (
        <div className="admin-pending-banner">
          <div className="admin-pending-banner-text">
            <span className="material-symbols-rounded">pending_actions</span>
            <span>Đang có <strong>{data.requests.length}</strong> yêu cầu chấm công chờ phê duyệt.</span>
          </div>
          <button
            type="button"
            className="admin-primary-button"
            onClick={() => { setFilter('action'); setPage(1); }}
          >
            <span className="material-symbols-rounded">checklist</span>
            Xử lý hàng loạt ({data.requests.length})
          </button>
        </div>
      ) : null}

      <section className="admin-panel admin-attendance-panel">
        <div className="admin-tabs" role="tablist" aria-label="Bộ lọc bảng công">
          {attendanceTabs.filter((tab) => canReview || tab.id !== 'action').map((tab) => (
            <button type="button" role="tab" aria-selected={filter === tab.id} className={filter === tab.id ? 'active' : ''} onClick={() => { setFilter(tab.id); setPage(1); }} key={tab.id}>
              {tab.label}{tab.id === 'action' && data.requests.length ? <b>{data.requests.length}</b> : null}
            </button>
          ))}
        </div>

        {canReview && filter === 'action' ? (
          <div className="admin-review-queue">
            {data.requests.length > 0 ? (
              <div className="admin-review-bulk">
                <div className="admin-review-bulk-main">
                  <label className="admin-review-bulk-label">
                    <input
                      ref={masterCheckboxRef}
                      type="checkbox"
                      checked={isAllSelected}
                      onChange={toggleSelectAll}
                      aria-label="Chọn tất cả yêu cầu"
                    />
                    <span>Chọn tất cả ({bulkCandidates.length})</span>
                  </label>
                  <div className="admin-review-bulk-chips">
                    <button
                      type="button"
                      className={`admin-review-chip ${requestFilter === 'ALL' ? 'active' : ''}`}
                      onClick={() => setRequestFilter('ALL')}
                    >
                      Tất cả ({data.requests.length})
                    </button>
                    <button
                      type="button"
                      className={`admin-review-chip ${requestFilter === 'EXPLANATION' ? 'active' : ''}`}
                      onClick={() => setRequestFilter('EXPLANATION')}
                    >
                      Giải trình ({explanationRequests.length})
                    </button>
                    <button
                      type="button"
                      className={`admin-review-chip ${requestFilter === 'CORRECTION' ? 'active' : ''}`}
                      onClick={() => setRequestFilter('CORRECTION')}
                    >
                      Điều chỉnh ({correctionRequests.length})
                    </button>
                    {selectedRequestIds.length > 0 ? (
                      <button
                        type="button"
                        className="admin-review-chip"
                        onClick={() => setSelectedRequestIds([])}
                      >
                        <span className="material-symbols-rounded" style={{ fontSize: 16 }}>restart_alt</span>
                        Bỏ chọn
                      </button>
                    ) : null}
                  </div>
                </div>

                <div className="admin-review-bulk-actions">
                  <span className="admin-review-bulk-count">
                    Đã chọn {selectedRequestIds.length} / {bulkCandidates.length}
                  </span>
                  <button
                    type="button"
                    className="admin-danger-button"
                    disabled={busy || !selectedRequestIds.length}
                    onClick={() => setBulkStatus('REJECTED')}
                    title={!selectedRequestIds.length ? 'Chọn ít nhất 1 yêu cầu để từ chối' : 'Từ chối các yêu cầu đã chọn'}
                  >
                    <span className="material-symbols-rounded">close</span>
                    Từ chối hàng loạt {selectedRequestIds.length ? `(${selectedRequestIds.length})` : ''}
                  </button>
                  <button
                    type="button"
                    className="admin-primary-button"
                    disabled={busy || !selectedRequestIds.length}
                    onClick={() => setBulkStatus('APPROVED')}
                    title={!selectedRequestIds.length ? 'Chọn ít nhất 1 yêu cầu để duyệt' : 'Phê duyệt các yêu cầu đã chọn'}
                  >
                    <span className="material-symbols-rounded">check</span>
                    Duyệt hàng loạt {selectedRequestIds.length ? `(${selectedRequestIds.length})` : ''}
                  </button>
                </div>
              </div>
            ) : null}

            {displayedRequests.map((request) => {
              const timesheet = timesheetsById.get(request.timesheet_id);
              const isSelected = selectedRequestIds.includes(request.id);
              return (
                <article className={`admin-review-card ${isSelected ? 'selected' : ''}`} key={request.id}>
                  <header>
                    <div>
                      <input
                        type="checkbox"
                        checked={isSelected}
                        disabled={!isSelected && selectedRequestIds.length >= TMS_LIMITS.ADMIN_BULK_REVIEW_LIMIT}
                        onChange={(event) => {
                          setSelectedRequestIds((current) =>
                            event.target.checked
                              ? [...new Set([...current, request.id])]
                              : current.filter((id) => id !== request.id),
                          );
                        }}
                        aria-label={`Chọn yêu cầu của ${employeeNames.get(request.employee_id) || request.employee_id}`}
                      />
                      <strong>{employeeNames.get(request.employee_id) || request.employee_id}</strong>
                      <span>{request.request_type === 'CORRECTION' ? 'Điều chỉnh giờ' : 'Giải trình'}</span>
                    </div>
                    <small>{formatDate(timesheet?.work_date || request.work_date || request.created_at.slice(0, 10))}</small>
                  </header>
                  {timesheet ? (
                    <div className="admin-time-compare">
                      <div><span>Dự kiến</span><strong>{formatClock(timesheet.expected_start)} → {formatClock(timesheet.expected_end)}</strong></div>
                      <div><span>Đã ghi nhận</span><strong>{formatClock(timesheet.actual_checkin)} → {formatClock(timesheet.actual_checkout)}</strong></div>
                      {request.request_type === 'CORRECTION' ? <div><span>Đề nghị</span><strong>{formatClock(request.requested_checkin || timesheet.actual_checkin)} → {formatClock(request.requested_checkout || timesheet.actual_checkout)}</strong></div> : null}
                    </div>
                  ) : null}
                  <p>{request.reason}</p>
                  <footer>
                    <input
                      value={reviewNotes[request.id] || ''}
                      onChange={(event) => setReviewNotes((current) => ({ ...current, [request.id]: event.target.value }))}
                      placeholder="Ghi chú phản hồi (không bắt buộc)"
                      aria-label={`Ghi chú phản hồi cho ${request.employee_id}`}
                    />
                    <button type="button" className="admin-danger-button" disabled={busy} onClick={() => void review(request, 'REJECTED')}>Từ chối</button>
                    <button type="button" className="admin-primary-button" disabled={busy} onClick={() => void review(request, 'APPROVED')}>Duyệt</button>
                  </footer>
                </article>
              );
            })}
            {!displayedRequests.length ? (
              <EmptyState
                icon="task_alt"
                title="Không có yêu cầu phù hợp"
                description={data.requests.length ? "Không tìm thấy yêu cầu theo phân loại đã chọn." : "Các ngày công bình thường vẫn được tự động duyệt theo chính sách."}
              />
            ) : null}
          </div>
        ) : null}

        <div className="admin-toolbar">
          <SearchField value={query} onChange={(value) => { setQuery(value); setPage(1); }} placeholder="Tên, mã nhân viên, địa điểm…" />
          <label className="admin-compact-field"><span>Tháng công</span><input type="month" value={month} onChange={(event) => { setPage(1); onMonthChange(event.target.value); }} /></label>
          {canExport ? <div className="admin-export-actions">
            <button type="button" className="admin-secondary-button" disabled={busy || !filteredTimesheets.length} onClick={() => void onRun(() => exportAttendanceExcel({ month, timesheets: filteredTimesheets, employees: data.employees, policies: data.policies }), 'Đã xuất chi tiết bảng công ra Excel.', { refresh: false })}><span className="material-symbols-rounded">download</span>Chi tiết Excel</button>
            <button type="button" className="admin-secondary-button" disabled={busy || !filteredTimesheets.length} onClick={() => void onRun(() => exportPayrollExcel({ month, timesheets: filteredTimesheets, employees: data.employees, policies: data.policies, closed: periodClosed }), 'Đã xuất dữ liệu payroll ra Excel.', { refresh: false })}><span className="material-symbols-rounded">request_quote</span>Payroll Excel</button>
          </div> : null}
          <div className="admin-period-control">
            <span className={`admin-period-state ${periodClosed ? 'closed' : 'draft'}`}><span className="material-symbols-rounded">{periodClosed ? 'verified' : 'edit_calendar'}</span>{periodClosed ? 'Đã đóng kỳ' : 'Bản nháp'}</span>
            {canLock && data.features.workforceOperations ? <button type="button" className="admin-primary-button" disabled={busy || periodClosed || unresolvedPeriodCount > 0 || range.to >= today} onClick={() => setConfirmClose(true)}><span className="material-symbols-rounded">lock</span>Đóng kỳ</button> : null}
          </div>
        </div>

        <div className="admin-timesheet-table" role="table" aria-label="Bảng công chi tiết">
          <div className="admin-timesheet-row admin-table-head" role="row">
            <span role="columnheader">Ngày</span><span role="columnheader">Nhân viên</span><span role="columnheader">Dự kiến</span><span role="columnheader">Thực tế</span><span role="columnheader">Giờ công</span><span role="columnheader">Trễ / sớm</span><span role="columnheader">Ngoại lệ</span><span role="columnheader">Trạng thái</span>
          </div>
          {visibleTimesheets.map((timesheet) => (
            <article className="admin-timesheet-row" role="row" key={timesheet.id}>
              <span data-label="Ngày" role="cell">{formatDate(timesheet.work_date)}</span>
              <span data-label="Nhân viên" role="cell"><strong>{employeeNames.get(timesheet.employee_id) || timesheet.employee_id}</strong><small>{timesheet.employee_id}</small></span>
              <span data-label="Dự kiến" role="cell">{formatClock(timesheet.expected_start)}–{formatClock(timesheet.expected_end)}</span>
              <span data-label="Thực tế" role="cell">{formatClock(timesheet.actual_checkin)}–{formatClock(timesheet.actual_checkout)}</span>
              <span data-label="Giờ công" role="cell"><strong>{formatHours(timesheet.work_minutes)}</strong></span>
              <span data-label="Trễ / sớm" role="cell">{timesheet.late_minutes}p / {timesheet.early_minutes}p</span>
              <span data-label="Ngoại lệ" role="cell" title={formatExceptions(timesheet.exception_codes)}>{formatExceptions(timesheet.exception_codes)}</span>
              <span data-label="Trạng thái" role="cell"><b className={`admin-status status-${timesheet.status.toLowerCase()}`}>{ATTENDANCE_STATUS_LABELS[timesheet.status]}</b></span>
            </article>
          ))}
          {!visibleTimesheets.length ? <EmptyState icon="filter_alt_off" title="Không có ngày công phù hợp" /> : null}
        </div>
        <Pagination page={safePage} pageCount={pageCount} onChange={setPage} summary={`${filteredTimesheets.length} ngày công · đã tải đủ tháng`} />
      </section>

      <ConfirmDialog
        isOpen={canLock && confirmClose}
        title={`Đóng kỳ công tháng ${month}?`}
        message={<label className="admin-dialog-field"><span>Ghi chú kỳ công</span><textarea value={closeNote} onChange={(event) => setCloseNote(event.target.value)} placeholder="Ví dụ: Đã đối soát với HR và quản lý các đơn vị" autoFocus /></label>}
        confirmLabel="Đóng và khóa kỳ"
        onConfirm={() => void confirmPeriodClose()}
        onCancel={() => setConfirmClose(false)}
        isLoading={busy}
        type="warning"
      />
      <ConfirmDialog
        isOpen={canReview && bulkStatus !== null}
        title={bulkStatus === 'APPROVED' ? `Duyệt hàng loạt ${selectedRequestIds.length} yêu cầu?` : `Từ chối hàng loạt ${selectedRequestIds.length} yêu cầu?`}
        message={
          <div className="admin-bulk-dialog-content">
            <p className="admin-bulk-dialog-desc">
              {bulkStatus === 'APPROVED'
                ? `Bạn đang thực hiện phê duyệt ${selectedRequestIds.length} yêu cầu chấm công được chọn. Thời gian công sẽ được cập nhật hợp lệ.`
                : `Bạn đang thực hiện từ chối ${selectedRequestIds.length} yêu cầu chấm công được chọn.`}
            </p>
            {selectedRequests.length > 0 ? (
              <div className="admin-bulk-selected-preview">
                <small className="admin-bulk-preview-title">Danh sách yêu cầu ({selectedRequests.length}):</small>
                <ul className="admin-bulk-preview-list">
                  {selectedRequests.slice(0, 8).map((req) => (
                    <li key={req.id}>
                      <strong>{employeeNames.get(req.employee_id) || req.employee_id}</strong>
                      <span>
                        {req.request_type === 'CORRECTION' ? 'Điều chỉnh giờ' : 'Giải trình'} · {formatDate(req.work_date || req.created_at.slice(0, 10))}
                      </span>
                    </li>
                  ))}
                  {selectedRequests.length > 8 ? (
                    <li className="admin-bulk-preview-more">+ {selectedRequests.length - 8} yêu cầu khác</li>
                  ) : null}
                </ul>
              </div>
            ) : null}
            <label className="admin-dialog-field">
              <span>Ghi chú phản hồi chung (không bắt buộc)</span>
              <textarea
                value={bulkNote}
                onChange={(event) => setBulkNote(event.target.value)}
                placeholder={bulkStatus === 'APPROVED' ? 'Ví dụ: Đã kiểm tra và duyệt theo xác nhận đơn vị' : 'Ví dụ: Lý do không hợp lệ hoặc thiếu xác nhận'}
                autoFocus
              />
              <div className="admin-bulk-preset-chips" aria-label="Gợi ý phản hồi nhanh">
                {(bulkStatus === 'APPROVED' ? ADMIN_BULK_NOTE_PRESETS.APPROVED : ADMIN_BULK_NOTE_PRESETS.REJECTED).map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    className="admin-bulk-preset-chip"
                    onClick={() => setBulkNote(preset)}
                  >
                    <span>+</span>
                    <span>{preset}</span>
                  </button>
                ))}
              </div>
            </label>
          </div>
        }
        confirmLabel={bulkStatus === 'APPROVED' ? `Xác nhận duyệt (${selectedRequestIds.length})` : `Xác nhận từ chối (${selectedRequestIds.length})`}
        onConfirm={() => void reviewBulk()}
        onCancel={() => { setBulkStatus(null); setBulkNote(''); }}
        isLoading={busy}
        type={bulkStatus === 'APPROVED' ? 'success' : 'warning'}
      />
    </div>
  );
}
