import React, { useMemo } from 'react';
import type { DashboardData, Employee, Explanation, LeaveRequest } from '@/shared/types';
import { formatDateString, toISODateString } from '@/core/utils/helpers';
import PullToRefresh from '@/shared/components/layout/PullToRefresh';
import { canApprove, DEFAULT_APPROVAL_ROLES } from '@/shared/constants';

interface Props {
    data: DashboardData | null;
    user: Employee;
    onSwitchTab: (tab: 'manager') => void;
    onRefresh: () => Promise<boolean | void>;
}

type NotificationEntry = (LeaveRequest & { category: 'leave' }) | (Explanation & { category: 'explanation' });
interface NotificationGroup { date: string; items: NotificationEntry[]; }

const NotificationsModal: React.FC<Props> = ({ data, user, onSwitchTab, onRefresh }) => {

    const managedLocationsSet = useMemo(() => {
        return new Set(user.managed_locations || []);
    }, [user.managed_locations]);

    const contacts = data?.contacts || [];

    const approvalRoles = data?.approvalRoles || DEFAULT_APPROVAL_ROLES;

    const { filteredApprovals, filteredExplanationApprovals } = useMemo(() => {
        const canLeave = canApprove(user.role, 'leave', approvalRoles);
        const canAttendance = canApprove(user.role, 'attendance', approvalRoles);
        const allApprovals = canLeave ? (data?.notifications.approvals || []) : [];
        const allExplanationApprovals = canAttendance ? (data?.notifications.explanationApprovals || []) : [];

        if (user.role === 'Admin' || user.role === 'HR') {
            return {
                filteredApprovals: allApprovals,
                filteredExplanationApprovals: allExplanationApprovals,
            };
        }

        if (canLeave || canAttendance) {
            const filterByUserScope = (approval: LeaveRequest | Explanation) => {
                const emp = contacts.find(c => c.employee_id === approval.employee_id);
                if (!emp) return false;
                const isDirectReport = String(emp.direct_manager_id) === String(user.employee_id);
                const isInManagedLocation = emp.center_id ? managedLocationsSet.has(emp.center_id) : false;
                return isDirectReport || isInManagedLocation;
            };

            return {
                filteredApprovals: allApprovals.filter(filterByUserScope),
                filteredExplanationApprovals: allExplanationApprovals.filter(filterByUserScope),
            };
        }

        return {
            filteredApprovals: [],
            filteredExplanationApprovals: [],
        };
    }, [data, user, contacts, managedLocationsSet, approvalRoles]);


    const pendingCount = filteredApprovals.length + filteredExplanationApprovals.length;

    const myNotifications = useMemo(() => {
        const myRequests = (data?.notifications.myRequests || []).filter(r => r.status !== 'Pending');
        const myExplanations = (data?.notifications.myExplanations || []).filter(r => r.status !== 'Pending');
        const combined = [
            ...myRequests.map(r => ({ ...r, category: 'leave' as const })),
            ...myExplanations.map(e => ({ ...e, category: 'explanation' as const }))
        ];
        const sorted = combined.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

        const groups: Record<string, NotificationEntry[]> = {};
        sorted.forEach(item => {
            const dateStr = item.created_at.split('T')[0] || 'unknown';
            const group = groups[dateStr] ?? [];
            group.push(item);
            groups[dateStr] = group;
        });

        return Object.entries(groups).map(([date, items]): NotificationGroup => ({
            date,
            items
        }));
    }, [data?.notifications.myRequests, data?.notifications.myExplanations]);

    const renderDateRange = (from: string | Date, to?: string | Date) => {
        const fromStr = typeof from === 'string' ? from.split('T')[0] : (from instanceof Date ? toISODateString(from) : '');
        const toStr = to ? (typeof to === 'string' ? to.split('T')[0] : (to instanceof Date ? toISODateString(to) : '')) : '';

        if (!toStr) return formatDateString(fromStr);
        const f = formatDateString(fromStr);
        const t = formatDateString(toStr);
        if (fromStr === toStr) return f;
        return `${f} - ${t}`;
    };

    const totalRead = myNotifications.reduce((acc, g) => acc + g.items.length, 0);

    return (
        <PullToRefresh onRefresh={onRefresh} className="page-bg flex flex-col font-sans overflow-y-auto h-full">
            <div className="employee-page employee-page-standard notifications-page animate-fade-in">
                <div className="ui-stack ui-stack-lg">
                    {/* Work waiting on you ---------------------------------- */}
                    {pendingCount > 0 && (
                        <button
                            type="button"
                            onClick={() => { onSwitchTab('manager'); }}
                            className="ui-banner animate-slide-up"
                            aria-label={`Mở ${pendingCount} đề xuất đang chờ duyệt`}
                        >
                            <span className="ui-banner-icon" aria-hidden="true">
                                <span className="material-symbols-rounded">fact_check</span>
                            </span>
                            <span className="ui-banner-body">
                                <span className="ui-banner-title">{pendingCount} đề xuất chờ bạn duyệt</span>
                                <span className="ui-banner-sub">Đơn nghỉ phép và giải trình của nhân sự bạn quản lý</span>
                            </span>
                            <span className="ui-banner-flag">Xử lý</span>
                        </button>
                    )}

                    {/* Your own decisions ----------------------------------- */}
                    {myNotifications.length === 0 && pendingCount === 0 ? (
                        <div className="ui-empty">
                            <span className="material-symbols-rounded" aria-hidden="true">notifications_off</span>
                            <span className="ui-empty-title">Không có thông báo mới</span>
                            <span className="ui-empty-text">Kết quả duyệt đơn của bạn sẽ hiển thị tại đây.</span>
                        </div>
                    ) : (
                        <>
                            {myNotifications.length > 0 && (
                                <div className="ui-label-row">
                                    <span className="ui-label">Đơn đã được xử lý</span>
                                    <span className="ui-pill ui-pill-muted">{totalRead} thông báo</span>
                                </div>
                            )}

                            {myNotifications.map((group) => (
                                <div key={group.date}>
                                    <div className="ui-daysep">
                                        <span className="ui-label">{formatDateString(group.date)}</span>
                                    </div>

                                    <section className="ui-card ui-card-flush">
                                        {group.items.map((item) => {
                                            const isApproved = item.status === 'Approved';
                                            const isRequest = item.category === 'leave';
                                            const statusTone = isApproved ? 'success' : 'danger';
                                            const type = isRequest ? item.type : 'Giải trình';
                                            const icon = !isRequest
                                                ? 'edit_document'
                                                : type.includes('Nghỉ phép') ? 'beach_access'
                                                    : type.includes('Công tác') ? 'flight_takeoff'
                                                        : type.includes('Nghỉ ốm') ? 'medical_services'
                                                            : type.includes('Làm việc tại nhà') ? 'home_work'
                                                                : 'description';
                                            const tone = !isRequest
                                                ? 'info'
                                                : type.includes('Nghỉ ốm') ? 'danger'
                                                    : type.includes('Công tác') ? 'info'
                                                        : type.includes('Làm việc tại nhà') ? 'success'
                                                            : 'primary';

                                            return (
                                                <article key={item.id} className="notice-item">
                                                    <div className="notice-head">
                                                        <span className={`ui-tile ui-tile-soft ui-tone-${tone}`} aria-hidden="true">
                                                            <span className="material-symbols-rounded">{icon}</span>
                                                        </span>
                                                        <span className="notice-title">
                                                            <span className="notice-name">{isRequest ? item.type : 'Giải trình công'}</span>
                                                            <span className="notice-date">
                                                                {renderDateRange(
                                                                    item.category === 'leave' ? item.from_date : item.date,
                                                                    item.category === 'leave' ? item.to_date : undefined,
                                                                )}
                                                            </span>
                                                        </span>
                                                        <span className={`ui-pill ui-pill-${statusTone}`}>
                                                            <span className="material-symbols-rounded" aria-hidden="true">{isApproved ? 'check_circle' : 'cancel'}</span>
                                                            {isApproved ? 'Đã duyệt' : 'Từ chối'}
                                                        </span>
                                                    </div>

                                                    {item.manager_note && (
                                                        <p className={`ui-note ${isApproved ? '' : 'ui-note-danger'}`.trim()}>
                                                            <span className="material-symbols-rounded" aria-hidden="true">forum</span>
                                                            <span><strong>Phản hồi quản lý: </strong>{item.manager_note}</span>
                                                        </p>
                                                    )}
                                                </article>
                                            );
                                        })}
                                    </section>
                                </div>
                            ))}
                        </>
                    )}
                </div>
            </div>
        </PullToRefresh>
    );
};

export default NotificationsModal;
