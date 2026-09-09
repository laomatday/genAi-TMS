import React, { useState, useMemo, useEffect } from 'react';
import { DashboardData, Employee } from '@/shared/types';
import { processRequest, processExplanation } from '@/modules/tms/services/employee';
import { formatDateString, triggerHaptic } from '@/core/utils/helpers';
import PullToRefresh from '@/shared/components/layout/PullToRefresh';
import { canApprove, DEFAULT_APPROVAL_ROLES } from '@/shared/constants';
import ModalListRequest from '@/modules/tms/components/ModalListRequest';
import type { ApprovalGroup, ApprovalItem, ApprovalTypeConfig } from '@/modules/tms/components/ModalListRequest';
import { useModalAccessibility } from '@/shared/components/modals/useModalAccessibility';

interface Props {
  data: DashboardData | null;
  user: Employee;
  onRefresh: () => Promise<void>;
  onAlert: (title: string, msg: string, type: 'success' | 'error') => void;
}

const TabManager: React.FC<Props> = ({ data, user, onRefresh, onAlert }) => {
  const [processing, setProcessing] = useState<string | null>(null);
  const [expandedApprovalGroup, setExpandedApprovalGroup] = useState<string | null>(null);

  const [rejectModal, setRejectModal] = useState<{
    isOpen: boolean;
    docId: string;
    type: 'leave' | 'explanation';
    reason: string;
  }>({ isOpen: false, docId: '', type: 'leave', reason: '' });
  const rejectDialogRef = useModalAccessibility(
    rejectModal.isOpen,
    () => setRejectModal((current) => ({ ...current, isOpen: false })),
    { closeOnEscape: !processing },
  );

  const contacts = data?.contacts || [];
  const approvalRoles = data?.approvalRoles || DEFAULT_APPROVAL_ROLES;
  const approvals = data?.notifications.approvals || [];
  const explanationApprovals = data?.notifications.explanationApprovals || [];

  const locationsMap = useMemo(() => {
    const map: Record<string, string> = {};
    data?.locations.forEach(l => map[l.center_id] = l.location_name);
    return map;
  }, [data?.locations]);

  const managedLocationsSet = useMemo(() => {
    return new Set(user.managed_locations || []);
  }, [user.managed_locations]);

  const groupedApprovals = useMemo(() => {
    const allItems = [
      ...approvals.map(a => ({ ...a, itemType: 'leave' as const })),
      ...explanationApprovals.map(e => ({ ...e, itemType: 'explanation' as const }))
    ];

    const filteredItems = allItems.filter(item => {
      const emp = contacts.find(c => c.employee_id === item.employee_id);
      if (!emp) return false;

      // Approval right depends on the request family and the configurable role map.
      const kind = item.itemType === 'leave' ? 'leave' : 'attendance';
      if (!canApprove(user.role, kind, approvalRoles)) return false;

      if (user.role === 'Admin' || user.role === 'HR') return true;

      const isDirectReport = String(emp.direct_manager_id) === String(user.employee_id);
      const isInManagedLocation = emp.center_id ? managedLocationsSet.has(emp.center_id) : false;
      return isDirectReport || isInManagedLocation;
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
  }, [approvals, explanationApprovals, contacts, locationsMap, managedLocationsSet, approvalRoles, user]);

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

  const handleAction = async (docId: string, status: 'Approved' | 'Rejected', type: 'leave' | 'explanation') => {
    triggerHaptic('medium');
    if (status === 'Rejected') {
      setRejectModal({ isOpen: true, docId, type, reason: '' });
      return;
    }

    const item = [...approvals, ...explanationApprovals].find(a => a.id === docId);
    if (!item) {
      onAlert('Lỗi', 'Yêu cầu không còn tồn tại. Vui lòng tải lại dữ liệu.', 'error');
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

    const managerNote = `${prefix}Duyệt bởi ${user.name}`;

    let res;
    if (type === 'leave') {
      res = await processRequest(docId, status, managerNote);
    } else {
      res = await processExplanation(docId, status, managerNote);
    }

    setProcessing(null);

    if (res.success) {
      onAlert("Thành công", "Đã duyệt yêu cầu.", "success");
      onRefresh();
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
      onAlert('Lỗi', 'Yêu cầu không còn tồn tại. Vui lòng tải lại dữ liệu.', 'error');
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
      onAlert("Thành công", "Đã từ chối yêu cầu.", "success");
      onRefresh();
    } else {
      onAlert("Lỗi", res.message || "Có lỗi xảy ra", "error");
    }
  };

  const renderDateRange = (from: string, to: string) => {
    if (!from || !to) return "N/A";
    const dateFromStr = formatDateString(from.split('T')[0]);
    const dateToStr = formatDateString(to.split('T')[0]);
    if (from.split('T')[0] === to.split('T')[0]) return dateFromStr;
    return `${dateFromStr} - ${dateToStr}`;
  };

  const getTypeConfig = (type: string, isLeave: boolean): ApprovalTypeConfig => {
    if (!isLeave) return { label: 'Giải trình công', icon: 'assignment_turned_in', tone: 'info' };
    if (type.includes('Nghỉ phép')) return { label: type, icon: 'beach_access', tone: 'primary' };
    if (type.includes('Nghỉ ốm')) return { label: type, icon: 'medical_services', tone: 'danger' };
    if (type.includes('Nghỉ không lương')) return { label: type, icon: 'event_busy', tone: 'warning' };
    if (type.includes('Làm việc tại nhà')) return { label: type, icon: 'home_work', tone: 'success' };
    if (type.includes('Công tác')) return { label: type, icon: 'flight_takeoff', tone: 'info' };
    return { label: type, icon: 'description', tone: 'muted' };
  };

  const totalPending = (groupedApprovals.directReports.length + Object.values(groupedApprovals.groups).flat().length);

  return (
    <PullToRefresh onRefresh={onRefresh} className="page-bg font-sans">
      <div className="employee-page employee-page-standard manager-page animate-fade-in space-y-8">
        <ModalListRequest
          processing={processing}
          handleAction={handleAction}
          expandedApprovalGroup={expandedApprovalGroup}
          setExpandedApprovalGroup={setExpandedApprovalGroup}
          totalPending={totalPending}
          approvalGroups={approvalGroups}
          renderDateRange={renderDateRange}
          getTypeConfig={getTypeConfig}
        />
      </div>

      {rejectModal.isOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900 dark:bg-dark-bg flex items-center justify-center p-6 animate-fade-in">
          <div ref={rejectDialogRef} tabIndex={-1} className="bg-white dark:bg-dark-surface rounded-xl w-full max-w-sm p-6 animate-scale-in shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="reject-request-title" aria-describedby="reject-request-description" aria-busy={!!processing}>
            <div className="text-center mb-6">
              <div className="w-14 h-14 bg-secondary-red/10 dark:bg-secondary-red/20 text-secondary-red dark:text-secondary-red rounded-full flex items-center justify-center mx-auto mb-4 border border-secondary-red/20 dark:border-secondary-red/30">
                <span className="material-symbols-rounded text-2xl">warning</span>
              </div>
              <h3 id="reject-request-title" className="text-lg font-extrabold text-slate-800 dark:text-dark-text-primary ">Từ chối yêu cầu?</h3>
              <p id="reject-request-description" className="text-sm text-slate-500 dark:text-dark-text-secondary mt-1">Nhập lý do để nhân viên biết nguyên nhân.</p>
            </div>

            <label htmlFor="reject-request-reason" className="sr-only">Lý do từ chối</label>
            <textarea
              id="reject-request-reason"
              className="textarea-field h-24 resize-none mb-4"
              placeholder="Lý do từ chối..."
              value={rejectModal.reason}
              onChange={(e) => setRejectModal({ ...rejectModal, reason: e.target.value })}
            ></textarea>

            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setRejectModal({ ...rejectModal, isOpen: false })}
                className="flex-1 py-4 rounded-xl bg-slate-100 dark:bg-dark-border/50 text-slate-600 dark:text-dark-text-primary text-base font-extrabold hover:bg-slate-200 dark:hover:bg-dark-border transition-colors uppercase tracking-widest"
              >
                Hủy
              </button>
              <button
                type="button"
                onClick={submitRejection}
                disabled={!rejectModal.reason.trim() || !!processing}
                className="flex-1 py-4 rounded-xl bg-secondary-red text-neutral-white text-base font-extrabold hover:bg-secondary-red/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed uppercase tracking-widest shadow-md shadow-secondary-red/20 flex items-center justify-center gap-2"
              >
                {processing ? <span className="material-symbols-rounded animate-spin">progress_activity</span> : 'Xác nhận'}
              </button>
            </div>
          </div>
        </div>
      )}
    </PullToRefresh>
  );
};

export default TabManager;
