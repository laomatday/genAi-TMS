import React, { useState, useMemo } from 'react';
import type { DashboardData, Employee, Explanation, LeaveRequest } from '@/shared/types';
import { deleteRequest, deleteExplanation } from '@/modules/tms/services/employee';
import { useToast } from '@/shared/contexts/useToast';
import ConfirmDialog from '@/shared/components/modals/ConfirmDialog';
import { formatDateString, triggerHaptic } from '@/core/utils/helpers';
import PullToRefresh from '@/shared/components/layout/PullToRefresh';
import { motion, AnimatePresence } from 'framer-motion';
import { displayRequestCode } from '@/modules/tms/utils/requestCode';

interface Props {
    data: DashboardData | null;
    user: Employee;
    onRefresh: () => Promise<boolean | void>;
    onCreateRequest?: (type?: string) => void;
    onCreateExplanation?: () => void;
}

type RequestListItem = (LeaveRequest & { itemType: 'leave' }) | (Explanation & { itemType: 'explanation' });

const STATUS_CONFIG: Record<string, { label: string; tone: string; icon: string }> = {
    Approved: { label: 'Đã duyệt', tone: 'success', icon: 'check_circle' },
    Rejected: { label: 'Từ chối', tone: 'danger', icon: 'cancel' },
    Pending: { label: 'Chờ duyệt', tone: 'warning', icon: 'pending' },
};

/** Quick-create shortcuts for the three request types staff file most often. */
const QUICK_TYPES: Array<{ type: string; label: string; icon: string }> = [
    { type: 'Nghỉ phép', label: 'Nghỉ phép', icon: 'beach_access' },
    { type: 'Làm việc tại nhà', label: 'WFH tại nhà', icon: 'home_work' },
    { type: 'Công tác', label: 'Đi công tác', icon: 'flight_takeoff' },
];

function typeIcon(type: string) {
    if (type.includes('Nghỉ ốm')) return 'medical_services';
    if (type.includes('Nghỉ không lương')) return 'event_busy';
    if (type.includes('Làm việc tại nhà') || type.includes('WFH')) return 'home_work';
    if (type.includes('Công tác')) return 'flight_takeoff';
    if (type.includes('Giải trình')) return 'assignment_turned_in';
    if (type.includes('Nghỉ phép')) return 'beach_access';
    return 'description';
}

/** Inclusive day span of a leave request; a same-day request counts as one day. */
function dayCount(from: string, to: string) {
    const start = new Date(`${from.slice(0, 10)}T00:00:00`);
    const end = new Date(`${to.slice(0, 10)}T00:00:00`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 1;
    return Math.max(1, Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1);
}

const TabRequests: React.FC<Props> = ({ data, onRefresh, user, onCreateRequest, onCreateExplanation }) => {
    const [viewMode, setViewMode] = useState<'leaves' | 'explanations'>('leaves');
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const [deleteConfirm, setDeleteConfirm] = useState<{ id: string, type: 'leave' | 'explanation' } | null>(null);
    const { showToast } = useToast();

    const requests = useMemo(() => [...(data?.myRequests || [])].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()), [data?.myRequests]);
    const explanations = useMemo(() => [...(data?.myExplanations || [])].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()), [data?.myExplanations]);

    const approverNames = useMemo(() => {
        const names: Record<string, string> = {};
        (data?.contacts || []).forEach(c => { names[c.employee_id] = c.name; });
        return names;
    }, [data?.contacts]);

    /** Annual-leave entitlement is not stored as a single number, so the quota bar
     *  is reconstructed: days already approved this year plus the balance left. */
    const leaveQuota = useMemo(() => {
        const year = new Date().getFullYear();
        const used = requests
            .filter(r => r.status === 'Approved' && r.type.includes('Nghỉ phép') && new Date(`${r.from_date}T00:00:00`).getFullYear() === year)
            .reduce((sum, r) => sum + dayCount(r.from_date, r.to_date), 0);
        const remaining = user.annual_leave_balance ?? 0;
        const total = used + remaining;
        return { used, remaining, total, ratio: total > 0 ? (remaining / total) * 100 : 0 };
    }, [requests, user.annual_leave_balance]);

    const isLeaveView = viewMode === 'leaves';
    const source = isLeaveView ? requests : explanations;
    const pendingCount = source.filter(item => item.status === 'Pending').length;
    const approvedCount = source.filter(item => item.status === 'Approved').length;

    const switchViewMode = (mode: 'leaves' | 'explanations') => { triggerHaptic('light'); setViewMode(mode); setExpandedId(null); };
    const toggleExpand = (id: string) => { triggerHaptic('light'); setExpandedId(prev => prev === id ? null : id); };

    const handleDelete = async () => {
        if (!deleteConfirm) return;
        triggerHaptic('medium');
        const res = deleteConfirm.type === 'leave' ? await deleteRequest(deleteConfirm.id) : await deleteExplanation(deleteConfirm.id);
        if (res.success) {
            showToast({ title: 'Thành công', body: res.message, type: 'success' });
            onRefresh();
        } else {
            showToast({ title: 'Lỗi', body: res.message, type: 'error' });
        }
        setDeleteConfirm(null);
    };

    const listItems: RequestListItem[] = isLeaveView
        ? requests.map((request) => ({ ...request, itemType: 'leave' as const }))
        : explanations.map((explanation) => ({ ...explanation, itemType: 'explanation' as const }));

    const containerVariants = { hidden: { opacity: 0 }, show: { opacity: 1, transition: { staggerChildren: .06 } } };
    const itemVariants = {
        hidden: { opacity: 0, y: 16 },
        show: { opacity: 1, y: 0, transition: { type: 'spring' as const, stiffness: 300, damping: 26 } } as const,
        exit: { opacity: 0, scale: .95, transition: { duration: .18 } },
    };

    return (
        <>
            <PullToRefresh onRefresh={onRefresh} className="page-bg font-sans">
                <div className="employee-page employee-page-standard requests-page animate-fade-in ui-stack">

                    {/* Type switch ---------------------------------------- */}
                    <div className="requests-switch">
                        {([
                            { mode: 'leaves' as const, icon: 'event_available', label: 'Nghỉ phép', sub: 'Leaves', count: requests.length },
                            { mode: 'explanations' as const, icon: 'assignment_turned_in', label: 'Giải trình', sub: 'Explanations', count: explanations.length },
                        ]).map(tab => (
                            <button
                                key={tab.mode}
                                type="button"
                                aria-pressed={viewMode === tab.mode}
                                className={`requests-switch-option ${viewMode === tab.mode ? 'requests-switch-option-active' : ''}`.trim()}
                                onClick={() => switchViewMode(tab.mode)}
                            >
                                <span className="material-symbols-rounded" aria-hidden="true">{tab.icon}</span>
                                <span className="requests-switch-text">
                                    <span className="requests-switch-label">{tab.label}</span>
                                    <span className="requests-switch-sub">{tab.sub}</span>
                                </span>
                                <span className="ui-pill ui-pill-muted">{tab.count}</span>
                            </button>
                        ))}
                    </div>

                    {/* Figures -------------------------------------------- */}
                    <div className="ui-metrics">
                        <div className="ui-metric">
                            <span className="ui-metric-head">
                                <span>Chờ duyệt</span>
                                <span className="material-symbols-rounded ui-tone-warning" aria-hidden="true">pending</span>
                            </span>
                            <span className={`ui-metric-value ${pendingCount > 0 ? 'ui-tone-warning' : ''}`.trim()}>
                                {pendingCount}
                                <span className="ui-metric-unit">đơn</span>
                            </span>
                            <span className="ui-metric-foot">{pendingCount > 0 ? 'Đang xử lý' : 'Không còn đơn treo'}</span>
                        </div>

                        <div className="ui-metric">
                            <span className="ui-metric-head">
                                <span>Đã duyệt</span>
                                <span className="material-symbols-rounded ui-tone-success" aria-hidden="true">task_alt</span>
                            </span>
                            <span className="ui-metric-value">
                                {approvedCount}
                                <span className="ui-metric-unit">đơn</span>
                            </span>
                            <span className="ui-metric-foot">Đã xử lý</span>
                        </div>

                        <div className="ui-metric">
                            <span className="ui-metric-head">
                                <span>Quỹ phép</span>
                                <span className="ui-metric-unit">{leaveQuota.remaining}/{leaveQuota.total}d</span>
                            </span>
                            <span className="ui-metric-value">
                                {leaveQuota.remaining}
                                <span className="ui-metric-unit">ngày</span>
                            </span>
                            <progress
                                className="ui-progress"
                                max={100}
                                value={Math.min(100, Math.max(0, leaveQuota.ratio))}
                                aria-label={`Còn ${leaveQuota.remaining} trên ${leaveQuota.total} ngày phép`}
                            />
                        </div>
                    </div>

                    {/* Create --------------------------------------------- */}
                    {isLeaveView && onCreateRequest ? (
                        <>
                            <button type="button" className="ui-cta" onClick={() => { triggerHaptic('light'); onCreateRequest(); }}>
                                <span className="material-symbols-rounded" aria-hidden="true">add_circle</span>
                                Tạo đề xuất mới
                            </button>

                            <div className="ui-chips">
                                {QUICK_TYPES.map(quick => (
                                    <button
                                        key={quick.type}
                                        type="button"
                                        className="ui-chip"
                                        onClick={() => { triggerHaptic('light'); onCreateRequest(quick.type); }}
                                    >
                                        <span className="material-symbols-rounded" aria-hidden="true">{quick.icon}</span>
                                        {quick.label}
                                    </button>
                                ))}
                            </div>
                        </>
                    ) : !isLeaveView && onCreateExplanation ? (
                        <button type="button" className="ui-cta" onClick={() => { triggerHaptic('light'); onCreateExplanation(); }}>
                            <span className="material-symbols-rounded" aria-hidden="true">edit_document</span>
                            Tạo giải trình mới
                        </button>
                    ) : null}

                    {/* History -------------------------------------------- */}
                    <div>
                        <div className="ui-label-row">
                            <span className="ui-label">{isLeaveView ? 'Lịch sử đề xuất' : 'Lịch sử giải trình'}</span>
                            <span className="ui-label">{listItems.length} bản ghi</span>
                        </div>

                        {listItems.length === 0 ? (
                            <div className="ui-empty">
                                <span className="material-symbols-rounded" aria-hidden="true">{isLeaveView ? 'folder_open' : 'history_edu'}</span>
                                <span className="ui-empty-title">{isLeaveView ? 'Chưa có đề xuất nào' : 'Chưa có giải trình nào'}</span>
                                <span className="ui-empty-text">
                                    {isLeaveView
                                        ? 'Các đề xuất bạn gửi sẽ hiển thị tại đây kèm trạng thái duyệt.'
                                        : 'Các giải trình bạn gửi sẽ hiển thị tại đây kèm trạng thái duyệt.'}
                                </span>
                            </div>
                        ) : (
                            <motion.div variants={containerVariants} initial="hidden" animate="show" className="ui-stack">
                                <AnimatePresence>
                                    {listItems.map((item) => {
                                        const status = STATUS_CONFIG[item.status] ?? STATUS_CONFIG.Pending;
                                        const icon = item.itemType === 'leave' ? typeIcon(item.type) : 'assignment_turned_in';
                                        const isExpanded = expandedId === item.id;
                                        const title = item.itemType === 'leave' ? item.type : 'Giải trình chấm công';
                                        const period = item.itemType === 'leave'
                                            ? (item.from_date === item.to_date
                                                ? formatDateString(item.from_date)
                                                : `${formatDateString(item.from_date)} → ${formatDateString(item.to_date)}`)
                                            : formatDateString(item.date);
                                        const days = item.itemType === 'leave' ? dayCount(item.from_date, item.to_date) : 1;
                                        const approver = item.approver_id ? approverNames[item.approver_id] || item.approver_id : null;
                                        const requestCode = displayRequestCode(item);

                                        return (
                                            <motion.section
                                                key={item.id}
                                                variants={itemVariants}
                                                className={`ui-card request-card ${item.status === 'Rejected' ? 'ui-card-attention' : ''}`.trim()}
                                            >
                                                <div
                                                    role="button"
                                                    tabIndex={0}
                                                    aria-expanded={isExpanded}
                                                    className="request-card-main"
                                                    onClick={() => toggleExpand(item.id)}
                                                    onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleExpand(item.id); } }}
                                                >
                                                    <div className="request-card-head">
                                                        <span className="ui-tile ui-tile-soft ui-tone-primary" aria-hidden="true">
                                                            <span className="material-symbols-rounded">{icon}</span>
                                                        </span>
                                                        <span className="request-card-title">
                                                            <span className="request-card-name">{title}</span>
                                                            {requestCode ? <span className="request-card-code">{requestCode}</span> : null}
                                                        </span>
                                                        <span className={`ui-pill ui-pill-${status?.tone ?? 'warning'}`}>
                                                            <span className="ui-pill-dot" aria-hidden="true" />
                                                            {status?.label ?? 'Chờ duyệt'}
                                                        </span>
                                                    </div>

                                                    <div className="request-card-period">
                                                        <span className="request-card-dates">{period}</span>
                                                        <span className="ui-pill ui-pill-muted">{days} ngày</span>
                                                    </div>

                                                    <p className={`request-card-reason ${isExpanded ? '' : 'request-card-reason-clamped'}`.trim()}>
                                                        <strong>{item.itemType === 'leave' ? 'Lý do:' : 'Nội dung:'}</strong> {item.reason}
                                                    </p>
                                                </div>

                                                {(approver || item.status === 'Pending') && (
                                                    <div className="request-card-footer">
                                                        <span className="request-card-approver">
                                                            <span className="material-symbols-rounded" aria-hidden="true">how_to_reg</span>
                                                            <span>{approver ? `Duyệt bởi ${approver}` : 'Chưa có người duyệt'}</span>
                                                        </span>
                                                        {item.status === 'Pending' && (
                                                            <button
                                                                type="button"
                                                                className="request-card-withdraw"
                                                                onClick={() => setDeleteConfirm({ id: item.id, type: item.itemType })}
                                                            >
                                                                <span className="material-symbols-rounded" aria-hidden="true">undo</span>
                                                                Thu hồi
                                                            </button>
                                                        )}
                                                    </div>
                                                )}

                                                {item.manager_note && item.status === 'Approved' && (
                                                    <div className="request-card-note">
                                                        <div className="ui-quote">
                                                            <span className="ui-tile ui-tile-sm ui-tone-success" aria-hidden="true">
                                                                <span className="material-symbols-rounded">forum</span>
                                                            </span>
                                                            <span className="ui-quote-body">
                                                                <span className="ui-quote-head">
                                                                    {approver || 'Quản lý'}
                                                                    <span className="ui-quote-time">{formatDateString(item.updated_at || item.created_at)}</span>
                                                                </span>
                                                                <p className="ui-quote-text">“{item.manager_note}”</p>
                                                            </span>
                                                        </div>
                                                    </div>
                                                )}

                                                {item.status === 'Rejected' && (
                                                    <div className="request-card-note">
                                                        <p className="ui-note ui-note-danger">
                                                            <span className="material-symbols-rounded" aria-hidden="true">error</span>
                                                            <span>
                                                                <strong>Lý do từ chối: </strong>
                                                                {item.manager_note || 'Quản lý chưa ghi lý do cụ thể.'}
                                                            </span>
                                                        </p>
                                                        {onCreateRequest && item.itemType === 'leave' && (
                                                            <button
                                                                type="button"
                                                                className="request-card-resubmit"
                                                                onClick={() => { triggerHaptic('light'); onCreateRequest(item.type); }}
                                                            >
                                                                <span className="material-symbols-rounded" aria-hidden="true">send</span>
                                                                Bổ sung &amp; gửi lại
                                                            </button>
                                                        )}
                                                    </div>
                                                )}
                                            </motion.section>
                                        );
                                    })}
                                </AnimatePresence>
                            </motion.div>
                        )}
                    </div>
                </div>
            </PullToRefresh>

            <ConfirmDialog
                isOpen={!!deleteConfirm}
                title="Thu hồi đề xuất?"
                message="Đề xuất sẽ bị xoá khỏi hàng đợi duyệt. Hành động này không thể hoàn tác."
                confirmLabel="Thu hồi"
                onConfirm={handleDelete}
                onCancel={() => setDeleteConfirm(null)}
                type="danger"
            />
        </>
    );
};

export default TabRequests;
