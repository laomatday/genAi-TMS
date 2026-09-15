import React, { useState, useMemo, useEffect, useCallback } from 'react';
import type { DashboardData, Employee, LeaveRequest } from '@/shared/types';
import { processRequest, processExplanation } from '@/modules/tms/services/employee';
import { formatDateString, triggerHaptic } from '@/core/utils/helpers';
import PullToRefresh from '@/shared/components/layout/PullToRefresh';
import Avatar from '@/shared/components/common/Avatar';
import { canApprove, DEFAULT_APPROVAL_ROLES } from '@/shared/constants';
import ModalListRequest from '@/modules/tms/components/ModalListRequest';
import type { ApprovalGroup, ApprovalItem, ApprovalTypeConfig } from '@/modules/tms/components/ModalListRequest';
import { useModalAccessibility } from '@/shared/components/modals/useModalAccessibility';
import { buildLocationNameMap } from '@/modules/tms/services/locations';
import { isReviewerTurn } from '@/modules/tms/utils/approvalTurn';

interface Props {
  data: DashboardData | null;
  user: Employee;
  onRefresh: () => Promise<boolean | void>;
  onAlert: (title: string, msg: string, type: 'success' | 'error') => void;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function inclusiveDayCount(from: string, to: string) {
  const start = new Date(`${from.slice(0, 10)}T00:00:00`);
  const end = new Date(`${to.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  return Math.max(1, Math.round((end.getTime() - start.getTime()) / DAY_MS) + 1);
}

function formatDateTime(value?: string) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return formatDateString(value.slice(0, 10));
  return date.toLocaleString('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function deadlineText(value?: string) {
  if (!value) return null;
  const dueAt = new Date(value);
  if (Number.isNaN(dueAt.getTime())) return null;
  const remaining = dueAt.getTime() - Date.now();
  const absolute = Math.abs(remaining);
  const days = Math.floor(absolute / DAY_MS);
  const hours = Math.floor((absolute % DAY_MS) / HOUR_MS);
  const minutes = Math.max(1, Math.floor((absolute % HOUR_MS) / MINUTE_MS));
  const duration = days > 0 ? `${days} ngày ${hours} giờ` : `${hours} giờ ${minutes} phút`;
  return remaining >= 0 ? `${duration} còn lại` : `Quá hạn ${duration}`;
}

interface ManagerApprovalDetailProps {
  item: ApprovalItem;
  reviewer: Employee;
  contacts: Employee[];
  teamLeaves: LeaveRequest[];
  locationNames: Record<string, string>;
  processing: string | null;
  note: string;
  getTypeConfig: (type: string, isLeave: boolean) => ApprovalTypeConfig;
  onNoteChange: (value: string) => void;
  onBack: () => void;
  onApprove: () => void;
  onReject: () => void;
}

const ManagerApprovalDetail: React.FC<ManagerApprovalDetailProps> = ({
  item,
  reviewer,
  contacts,
  teamLeaves,
  locationNames,
  processing,
  note,
  getTypeConfig,
  onNoteChange,
  onBack,
  onApprove,
  onReject,
}) => {
  const isLeave = item.itemType === 'leave';
  const config = getTypeConfig(isLeave ? item.type : '', isLeave);
  const employee = item.emp || contacts.find(contact => contact.employee_id === item.employee_id);
  const itemName = item.name || employee?.name || item.employee_id;
  const fromDate = isLeave ? item.from_date : item.date;
  const toDate = isLeave ? item.to_date : item.date;
  const duration = inclusiveDayCount(fromDate, toDate);
  const dueAt = isLeave ? item.due_at : undefined;
  const deadline = deadlineText(dueAt);
  const directManager = employee?.direct_manager_id
    ? contacts.find(contact => contact.employee_id === employee.direct_manager_id)
    : null;
  const activeReviewerId = item.assigned_to ?? null;
  const assignedReviewer = activeReviewerId
    ? contacts.find(contact => contact.employee_id === activeReviewerId)
    : null;
  const isMyTurn = isReviewerTurn(item, reviewer.employee_id);
  const overlappingLeaves = teamLeaves.filter(leave => (
    leave.status === 'Approved'
    && leave.employee_id !== item.employee_id
    && leave.from_date <= toDate
    && leave.to_date >= fromDate
  ));
  const overlappingEmployees = overlappingLeaves.reduce<Employee[]>((result, leave) => {
    const contact = contacts.find(person => person.employee_id === leave.employee_id);
    if (contact && !result.some(person => person.employee_id === contact.employee_id)) result.push(contact);
    return result;
  }, []);

  return (
    <div className="manager-detail ui-stack animate-fade-in">
      <div className="manager-detail-toolbar">
        <button type="button" className="manager-detail-back" disabled={!!processing} onClick={onBack}>
          <span className="material-symbols-rounded" aria-hidden="true">arrow_back</span>
          Hàng đợi
        </button>
      </div>

      <section className="ui-card manager-status-card">
        <div className="manager-status-main">
          <span className={`ui-tile ui-tile-soft ui-tone-${config.tone}`} aria-hidden="true">
            <span className="material-symbols-rounded">{config.icon}</span>
          </span>
          <span className="manager-status-copy">
            <span className="manager-status-title">Chờ phê duyệt</span>
            <span className="manager-status-sub">Gửi lúc {formatDateTime(item.created_at)}</span>
          </span>
        </div>
        {deadline ? (
          <div className={`manager-deadline ${dueAt && new Date(dueAt).getTime() < Date.now() ? 'manager-deadline-overdue' : ''}`.trim()}>
            <span className="material-symbols-rounded" aria-hidden="true">timer</span>
            <span>Thời hạn xử lý</span>
            <strong>{deadline}</strong>
          </div>
        ) : null}
      </section>

      <section className="ui-card manager-person-card">
        <div className="manager-person-head">
          <Avatar
            src={employee?.face_ref_url || employee?.avatar_url}
            name={itemName}
            className="manager-person-avatar"
            textSize="text-sm"
          />
          <span className="manager-person-copy">
            <span className="manager-person-title">{itemName}</span>
            <span className="manager-person-sub">
              {[employee?.position, employee?.department].filter(Boolean).join(' • ') || 'Chưa cập nhật vị trí công việc'}
            </span>
            <span className="manager-person-meta">
              <span>{item.employee_id}</span>
              {employee?.center_id ? <span>{locationNames[employee.center_id] || employee.center_id}</span> : null}
            </span>
          </span>
        </div>
        <div className="manager-person-facts">
          {isLeave ? (
            <div>
              <span>Phép còn lại</span>
              <strong>{employee?.annual_leave_balance ?? '—'} <small>ngày</small></strong>
            </div>
          ) : (
            <div>
              <span>Ngày cần điều chỉnh</span>
              <strong>{formatDateString(fromDate)}</strong>
            </div>
          )}
          <div>
            <span>Quản lý trực tiếp</span>
            <strong>{directManager?.name || employee?.direct_manager_id || 'Chưa gán'}</strong>
          </div>
        </div>
      </section>

      <section className="ui-card manager-request-detail">
        <div className="manager-section-head">
          <span className={`ui-row-icon ui-tone-${config.tone}`} aria-hidden="true">
            <span className="material-symbols-rounded">{config.icon}</span>
          </span>
          <span>
            <strong>{config.label}</strong>
            {duration !== null ? <small>{duration} ngày</small> : null}
          </span>
        </div>

        <div className="manager-date-range">
          <span>
            <small>{isLeave ? 'Bắt đầu nghỉ' : 'Ngày chấm công'}</small>
            <strong>{formatDateString(fromDate)}</strong>
          </span>
          {isLeave && fromDate !== toDate ? (
            <>
              <span className="material-symbols-rounded" aria-hidden="true">arrow_forward</span>
              <span className="manager-date-end">
                <small>Quay lại làm</small>
                <strong>{formatDateString(toDate)}</strong>
              </span>
            </>
          ) : null}
        </div>

        {!isLeave && (item.requested_checkin || item.requested_checkout) ? (
          <div className="manager-request-times">
            <span>Giờ vào <strong>{item.requested_checkin || 'Không đổi'}</strong></span>
            <span>Giờ ra <strong>{item.requested_checkout || 'Không đổi'}</strong></span>
          </div>
        ) : null}

        <div className="manager-reason">
          <span>Lý do đề xuất</span>
          <blockquote>{item.reason || 'Người gửi chưa cung cấp lý do.'}</blockquote>
        </div>
      </section>

      <section className="ui-card manager-impact-card">
        <div className="manager-section-head">
          <span className="ui-row-icon ui-tone-success" aria-hidden="true">
            <span className="material-symbols-rounded">groups</span>
          </span>
          <span>
            <strong>Ảnh hưởng nhân sự cùng kỳ</strong>
            <small>Dựa trên các đơn đã duyệt đang tải</small>
          </span>
          <span className={`ui-pill ${overlappingEmployees.length ? 'ui-pill-warning' : 'ui-pill-success'}`}>
            {overlappingEmployees.length} người trùng lịch
          </span>
        </div>
        {overlappingEmployees.length > 0 ? (
          <div className="manager-overlap-list">
            {overlappingEmployees.slice(0, 3).map(person => (
              <div key={person.employee_id} className="manager-overlap-person">
                <Avatar src={person.face_ref_url || person.avatar_url} name={person.name} className="w-8 h-8 rounded-lg" textSize="text-xs" />
                <span><strong>{person.name}</strong><small>{person.position || person.department || person.employee_id}</small></span>
              </div>
            ))}
            {overlappingEmployees.length > 3 ? <small className="manager-overlap-more">Và {overlappingEmployees.length - 3} người khác</small> : null}
          </div>
        ) : (
          <p className="manager-impact-empty">Không có nhân sự khác nghỉ trùng kỳ trong phạm vi dữ liệu hiện tại.</p>
        )}
      </section>

      <section className="ui-card manager-process-card">
        <div className="manager-section-head">
          <span className="ui-row-icon ui-tone-primary" aria-hidden="true">
            <span className="material-symbols-rounded">account_tree</span>
          </span>
          <span><strong>Quy trình phê duyệt</strong><small>Trạng thái hiện tại</small></span>
        </div>
        <ol className="manager-timeline">
          <li className="manager-timeline-done">
            <span className="material-symbols-rounded" aria-hidden="true">check</span>
            <p><strong>Gửi yêu cầu</strong><small>{itemName} · {formatDateTime(item.created_at)}</small></p>
          </li>
          <li className="manager-timeline-current">
            <span className="material-symbols-rounded" aria-hidden="true">hourglass_top</span>
            <p>
              <strong>Chờ quyết định</strong>
              <small>
                {isMyTurn
                  ? 'Bạn đang được phân công xử lý'
                  : `${assignedReviewer?.name || activeReviewerId} đang được phân công xử lý`}
              </small>
            </p>
          </li>
          <li>
            <span className="material-symbols-rounded" aria-hidden="true">sync</span>
            <p><strong>Cập nhật hệ thống</strong><small>Dữ liệu phép và bảng công được đồng bộ sau quyết định</small></p>
          </li>
        </ol>
      </section>

      {isMyTurn ? (
        <section className="ui-card manager-note-card">
          <label htmlFor="manager-approval-note">Lời nhắn cho nhân sự <span>Tùy chọn</span></label>
          <textarea
            id="manager-approval-note"
            className="ui-control"
            rows={3}
            maxLength={500}
            value={note}
            placeholder="Nhập lời nhắn kèm theo quyết định…"
            onChange={event => onNoteChange(event.target.value)}
          />
          <small>{note.length}/500</small>
        </section>
      ) : null}

      {isMyTurn ? (
        <div className="manager-detail-actions" aria-label="Thao tác phê duyệt">
          <button type="button" className="approval-action approval-action-reject" disabled={!!processing} onClick={onReject}>
            <span className="material-symbols-rounded" aria-hidden="true">close</span>
            Từ chối
          </button>
          <button type="button" className="approval-action approval-action-approve" disabled={!!processing} onClick={onApprove}>
            {processing ? <span className="material-symbols-rounded ui-spin" aria-hidden="true">progress_activity</span> : <span className="material-symbols-rounded" aria-hidden="true">verified</span>}
            Phê duyệt đề xuất
          </button>
        </div>
      ) : (
        <section className="ui-card manager-handover-card">
          <span className="ui-row-icon ui-tone-muted" aria-hidden="true">
            <span className="material-symbols-rounded">hourglass_top</span>
          </span>
          <div>
            <strong>Đang chờ người khác xử lý</strong>
            <p>
              Bước hiện tại thuộc về <b>{assignedReviewer?.name || activeReviewerId}</b>
              {assignedReviewer?.role ? ` (${assignedReviewer.role})` : ''}. Yêu cầu vẫn
              hiện ở đây để bạn theo dõi, nhưng quyết định phải do người này đưa ra.
            </p>
          </div>
        </section>
      )}
    </div>
  );
};

const TabManager: React.FC<Props> = ({ data, user, onRefresh, onAlert }) => {
  const [processing, setProcessing] = useState<string | null>(null);
  const [expandedApprovalGroup, setExpandedApprovalGroup] = useState<string | null>(null);
  const [selectedApprovalId, setSelectedApprovalId] = useState<string | null>(null);
  const [approvalNote, setApprovalNote] = useState('');

  const [rejectModal, setRejectModal] = useState<{
    isOpen: boolean;
    docId: string;
    type: 'leave' | 'explanation';
    reason: string;
  }>({ isOpen: false, docId: '', type: 'leave', reason: '' });
  const closeRejectModal = useCallback(() => {
    setRejectModal((current) => ({ ...current, isOpen: false }));
  }, []);
  const rejectDialogRef = useModalAccessibility(
    rejectModal.isOpen,
    closeRejectModal,
    { closeOnEscape: !processing },
  );

  const contacts = useMemo(() => data?.contacts || [], [data?.contacts]);
  const approvalRoles = data?.approvalRoles || DEFAULT_APPROVAL_ROLES;
  const approvals = useMemo(() => data?.notifications.approvals || [], [data?.notifications.approvals]);
  const explanationApprovals = useMemo(
    () => data?.notifications.explanationApprovals || [],
    [data?.notifications.explanationApprovals],
  );

  const locationsMap = useMemo(() => buildLocationNameMap(data), [data]);

  const groupedApprovals = useMemo(() => {
    const allItems = [
      ...approvals.map(a => ({ ...a, itemType: 'leave' as const })),
      ...explanationApprovals.map(e => ({ ...e, itemType: 'explanation' as const }))
    ];

    const filteredItems = allItems.filter(item => {
      // The Workforce query already applies tenant, assignment and management
      // scope. Re-filtering by the separately paged directory could silently
      // hide a valid request when the tenant has more than one directory page.
      const kind = item.itemType === 'leave' ? 'leave' : 'attendance';
      return canApprove(user.role, kind, approvalRoles);
    });

    const groups: Record<string, ApprovalItem[]> = {};
    const directReports: ApprovalItem[] = [];

    filteredItems.forEach(item => {
      const emp = contacts.find(c => c.employee_id === item.employee_id);

      if (emp && String(emp.direct_manager_id) === String(user.employee_id)) {
        directReports.push({ ...item, emp });
        return;
      }

      const centerId = emp?.center_id || 'Unknown Center';
      const centerName = locationsMap[centerId] || centerId;

      const group = groups[centerName] ?? [];
      group.push({ ...item, emp });
      groups[centerName] = group;
    });

    return { directReports, groups };
  }, [approvals, explanationApprovals, contacts, locationsMap, approvalRoles, user]);

  const approvalGroups = useMemo<ApprovalGroup[]>(() => {
    const groups: ApprovalGroup[] = [];
    if (groupedApprovals.directReports.length > 0) {
      groups.push({ id: 'direct', title: 'Quản lý trực tiếp', items: groupedApprovals.directReports });
    }
    Object.keys(groupedApprovals.groups).forEach(centerName => {
      groups.push({ id: centerName, title: centerName, items: groupedApprovals.groups[centerName] ?? [] });
    });
    return groups;
  }, [groupedApprovals]);

  const resolveEmployeeName = useCallback(
    (employeeId: string) => contacts.find(contact => contact.employee_id === employeeId)?.name || employeeId,
    [contacts],
  );

  const selectedApproval = useMemo(
    () => approvalGroups.flatMap(group => group.items).find(item => item.id === selectedApprovalId) || null,
    [approvalGroups, selectedApprovalId],
  );

  useEffect(() => {
    if (approvalGroups.length > 0) {
      setExpandedApprovalGroup(prev => {
        if (prev && approvalGroups.some(g => g.id === prev)) return prev;
        return approvalGroups[0]?.id || null;
      });
    } else {
      setExpandedApprovalGroup(null);
    }
  }, [approvalGroups]);

  useEffect(() => {
    if (selectedApprovalId && !selectedApproval) {
      setSelectedApprovalId(null);
      setApprovalNote('');
    }
  }, [selectedApproval, selectedApprovalId]);

  const handleAction = async (
    docId: string,
    status: 'Approved' | 'Rejected',
    type: 'leave' | 'explanation',
    decisionNote = '',
  ) => {
    triggerHaptic('medium');
    if (status === 'Rejected') {
      setRejectModal({ isOpen: true, docId, type, reason: decisionNote.trim() });
      return;
    }

    const item = [...approvals, ...explanationApprovals].find(a => a.id === docId);
    if (!item) {
      onAlert('Lỗi', 'Đề xuất không còn tồn tại. Vui lòng tải lại dữ liệu.', 'error');
      await onRefresh();
      return;
    }
    setProcessing(docId);
    const requester = contacts.find(c => c.employee_id === item?.employee_id);
    const isDirect = String(requester?.direct_manager_id) === String(user.employee_id);

    let prefix = "";
    if (!isDirect) {
      if (user.role === 'Director') prefix = `[Duyệt thay bởi Director: ${user.name}] `;
      else if (user.role === 'HR') prefix = `[Xử lý ngoại lệ bởi HR] `;
      else if (user.role === 'Admin') prefix = `[Xử lý bởi Admin] `;
      else if (user.role === 'Manager') prefix = `[Duyệt thay bởi Manager: ${user.name}] `;
    }

    const managerNote = decisionNote.trim()
      ? `${prefix}${decisionNote.trim()} (Duyệt bởi ${user.name})`
      : `${prefix}Duyệt bởi ${user.name}`;

    let res;
    if (type === 'leave') {
      res = await processRequest(docId, status, managerNote);
    } else {
      res = await processExplanation(docId, status, managerNote);
    }

    setProcessing(null);

    if (res.success) {
      onAlert("Thành công", "Đã duyệt đề xuất.", "success");
      setSelectedApprovalId(null);
      setApprovalNote('');
      void onRefresh();
    } else {
      onAlert("Lỗi", res.message || "Có lỗi xảy ra", "error");
    }
  };

  const submitRejection = async () => {
    if (!rejectModal.docId) return;
    const { docId, type, reason } = rejectModal;

    const item = [...approvals, ...explanationApprovals].find(a => a.id === docId);
    if (!item) {
      setRejectModal({ ...rejectModal, isOpen: false });
      onAlert('Lỗi', 'Đề xuất không còn tồn tại. Vui lòng tải lại dữ liệu.', 'error');
      await onRefresh();
      return;
    }
    setProcessing(docId);
    const requester = contacts.find(c => c.employee_id === item?.employee_id);
    const isDirect = String(requester?.direct_manager_id) === String(user.employee_id);

    let prefix = "";
    if (!isDirect) {
      if (user.role === 'Director') prefix = `[Từ chối thay bởi Director: ${user.name}] `;
      else if (user.role === 'HR') prefix = `[Xử lý ngoại lệ bởi HR] `;
      else if (user.role === 'Admin') prefix = `[Xử lý bởi Admin] `;
      else if (user.role === 'Manager') prefix = `[Từ chối thay bởi Manager: ${user.name}] `;
    }

    const managerNote = reason ? `${prefix}${reason} (Từ chối bởi ${user.name})` : `${prefix}Từ chối bởi ${user.name}`;

    let res;
    if (type === 'leave') {
      res = await processRequest(docId, 'Rejected', managerNote);
    } else {
      res = await processExplanation(docId, 'Rejected', managerNote);
    }

    setProcessing(null);
    setRejectModal({ ...rejectModal, isOpen: false });

    if (res.success) {
      onAlert("Thành công", "Đã từ chối đề xuất.", "success");
      setSelectedApprovalId(null);
      setApprovalNote('');
      void onRefresh();
    } else {
      onAlert("Lỗi", res.message || "Có lỗi xảy ra", "error");
    }
  };

  const renderDateRange = useCallback((from: string, to: string) => {
    if (!from || !to) return "N/A";
    const dateFromStr = formatDateString(from.split('T')[0]);
    const dateToStr = formatDateString(to.split('T')[0]);
    if (from.split('T')[0] === to.split('T')[0]) return dateFromStr;
    return `${dateFromStr} - ${dateToStr}`;
  }, []);

  const getTypeConfig = useCallback((type: string, isLeave: boolean): ApprovalTypeConfig => {
    if (!isLeave) return { label: 'Giải trình công', icon: 'assignment_turned_in', tone: 'info' };
    if (type.includes('Nghỉ phép')) return { label: type, icon: 'beach_access', tone: 'primary' };
    if (type.includes('Nghỉ ốm')) return { label: type, icon: 'medical_services', tone: 'danger' };
    if (type.includes('Nghỉ không lương')) return { label: type, icon: 'event_busy', tone: 'warning' };
    if (type.includes('Làm việc tại nhà')) return { label: type, icon: 'home_work', tone: 'success' };
    if (type.includes('Công tác')) return { label: type, icon: 'flight_takeoff', tone: 'info' };
    return { label: type, icon: 'description', tone: 'muted' };
  }, []);

  const totalPending = (groupedApprovals.directReports.length + Object.values(groupedApprovals.groups).flat().length);

  return (
    <PullToRefresh onRefresh={onRefresh} className="page-bg font-sans">
      <div className="employee-page employee-page-standard manager-page animate-fade-in">
        {selectedApproval ? (
          <ManagerApprovalDetail
            item={selectedApproval}
            reviewer={user}
            contacts={contacts}
            teamLeaves={data?.teamLeaves ?? []}
            locationNames={locationsMap}
            processing={processing}
            note={approvalNote}
            getTypeConfig={getTypeConfig}
            onNoteChange={setApprovalNote}
            onBack={() => { triggerHaptic('light'); setSelectedApprovalId(null); setApprovalNote(''); }}
            onApprove={() => void handleAction(selectedApproval.id, 'Approved', selectedApproval.itemType, approvalNote)}
            onReject={() => void handleAction(selectedApproval.id, 'Rejected', selectedApproval.itemType, approvalNote)}
          />
        ) : (
          <ModalListRequest
            viewerId={user.employee_id}
            resolveName={resolveEmployeeName}
            expandedApprovalGroup={expandedApprovalGroup}
            setExpandedApprovalGroup={setExpandedApprovalGroup}
            totalPending={totalPending}
            approvalGroups={approvalGroups}
            renderDateRange={renderDateRange}
            getTypeConfig={getTypeConfig}
            onOpenDetail={(item) => { triggerHaptic('light'); setSelectedApprovalId(item.id); setApprovalNote(''); }}
          />
        )}
      </div>

      {rejectModal.isOpen && (
        <div className="confirm-backdrop animate-fade-in">
          <section
            ref={rejectDialogRef}
            tabIndex={-1}
            className="confirm-dialog animate-scale-in"
            role="dialog"
            aria-modal="true"
            aria-labelledby="reject-request-title"
            aria-describedby="reject-request-description"
            aria-busy={!!processing}
          >
            <div className="confirm-content">
              <div className="confirm-icon confirm-icon-danger">
                <span className="material-symbols-rounded" aria-hidden="true">block</span>
              </div>
              <h3 id="reject-request-title">Từ chối đề xuất?</h3>
              <p id="reject-request-description" className="confirm-message">
                Nhân viên sẽ thấy lý do bạn ghi ở đây, nên hãy nêu cụ thể.
              </p>

              <div className="confirm-form ui-field">
                <label className="ui-field-label ui-field-label-required" htmlFor="reject-request-reason">Lý do từ chối</label>
                <textarea
                  id="reject-request-reason"
                  className="ui-control"
                  maxLength={500}
                  placeholder="Ví dụ: thiếu giấy tờ bệnh viện, trùng lịch trực…"
                  value={rejectModal.reason}
                  onChange={(e) => setRejectModal({ ...rejectModal, reason: e.target.value })}
                />
                <span className="ui-field-foot">
                  <span>Lý do được đính kèm vào đơn.</span>
                  <span>{rejectModal.reason.length}/500</span>
                </span>
              </div>
            </div>

            <div className="confirm-actions">
              <button
                type="button"
                onClick={closeRejectModal}
                disabled={!!processing}
                className="ui-button ui-button-quiet"
              >
                Hủy
              </button>
              <button
                type="button"
                onClick={submitRejection}
                disabled={!rejectModal.reason.trim() || !!processing}
                className="ui-button ui-button-danger"
              >
                {processing ? (
                  <span className="material-symbols-rounded ui-spin" aria-hidden="true">progress_activity</span>
                ) : (
                  'Xác nhận từ chối'
                )}
              </button>
            </div>
          </section>
        </div>
      )}
    </PullToRefresh>
  );
};

export default TabManager;
