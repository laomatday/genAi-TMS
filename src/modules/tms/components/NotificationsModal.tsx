import React, { useMemo } from 'react';
import type { DashboardData, Employee, Explanation, LeaveRequest } from '@/shared/types';
import { formatDateString, toISODateString } from '@/core/utils/helpers';
import PullToRefresh from '@/shared/components/layout/PullToRefresh';
import { canApprove, DEFAULT_APPROVAL_ROLES } from '@/shared/constants';

interface Props {
    data: DashboardData | null;
    user: Employee;
    onSwitchTab: (tab: 'manager') => void;
    onRefresh: () => Promise<void>;
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

    return (
        <PullToRefresh onRefresh={onRefresh} className="page-bg flex flex-col font-sans overflow-y-auto h-full">
            <div className="employee-page employee-page-standard notifications-page animate-fade-in">

                {pendingCount > 0 && (
                    <button
                        type="button"
                        onClick={() => { onSwitchTab('manager'); }}
                        className="app-surface notification-attention app-interactive-card group animate-slide-up w-full text-left"
                        aria-label={`Mở ${pendingCount} yêu cầu đang chờ duyệt`}
                    >
                        <div className="absolute top-0 right-0 w-32 h-32 bg-primary/10 dark:bg-primary/20 rounded-full blur-3xl pointer-events-none -mr-10 -mt-10 opacity-60"></div>

                        <div className="relative z-10 flex items-center justify-between">
                            <div>
                                <div className="flex items-center gap-2 mb-2">
                                    <span className="relative flex h-2.5 w-2.5">
                                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-secondary-red/50 opacity-75"></span>
                                        <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-secondary-red"></span>
                                    </span>
                                    <span className="text-xxs font-extrabold uppercase tracking-wider text-primary dark:text-primary bg-primary/10 dark:bg-primary/20 px-2 py-0.5 rounded-md border border-primary/20 dark:border-primary/30">Cần duyệt ngay</span>
                                </div>

                                <div className="flex items-baseline gap-1.5">
                                    <h3 className="text-4xl font-black text-slate-800 dark:text-dark-text-primary  leading-none tabular-nums">{pendingCount}</h3>
                                    <span className="text-sm font-bold text-slate-400 dark:text-dark-text-secondary uppercase tracking-wide">Yêu cầu</span>
                                </div>
                                <p className="text-slate-500 dark:text-dark-text-secondary text-xs font-medium mt-1 group-hover:text-primary dark:group-hover:text-primary transition-colors">
                                    Đang chờ bạn xử lý
                                </p>
                            </div>

                            <div className="w-14 h-14 bg-primary/10 dark:bg-primary/20 text-primary dark:text-primary rounded-xl flex items-center justify-center text-xl border border-primary/20 dark:border-primary/30 group-hover:bg-primary dark:group-hover:bg-primary group-hover:text-white transition-all duration-300">
                                <span className="material-symbols-rounded group-hover:translate-x-1 transition-transform">arrow_right_alt</span>
                            </div>
                        </div>
                    </button>
                )}

                <div className="space-y-8">
                    {myNotifications.length === 0 && pendingCount === 0 ? (
                        <div className="flex flex-col items-center justify-center py-20 text-slate-400 dark:text-dark-text-secondary/60 opacity-60 animate-fade-in">
                            <div className="w-24 h-24 bg-slate-100 dark:bg-dark-surface rounded-full flex items-center justify-center mb-4 border border-slate-200 dark:border-dark-border">
                                <span className="material-symbols-rounded text-4xl text-slate-300 dark:text-dark-text-secondary">notifications_off</span>
                            </div>
                            <p className="text-sm font-bold text-slate-500 dark:text-dark-text-secondary uppercase tracking-wide">Không có thông báo mới</p>
                        </div>
                    ) : (
                        <>
                            {myNotifications.length > 0 && (
                                <div className="flex items-center justify-between px-2 mb-2">
                                    <h4 className="text-xs font-black text-primary dark:text-primary uppercase tracking-widest animate-slide-up">Các đơn đã duyệt</h4>
                                    <span className="text-xxs font-bold text-slate-400 dark:text-dark-text-secondary bg-slate-100 dark:bg-dark-border/50 px-2 py-0.5 rounded-full">
                                        {myNotifications.reduce((acc, g) => acc + g.items.length, 0)} thông báo
                                    </span>
                                </div>
                            )}

                            {myNotifications.map((group) => (
                                <div key={group.date} className="space-y-3">
                                    <div className="flex items-center gap-3 px-2">
                                        <span className="text-xxs font-black text-slate-400 dark:text-dark-text-secondary uppercase tracking-widest">{formatDateString(group.date)}</span>
                                        <div className="h-px flex-1 bg-slate-100 dark:bg-dark-border/30"></div>
                                    </div>

                                    <div className="app-list-surface divide-y divide-slate-50 dark:divide-dark-border">
                                        {group.items.map((item) => {
                                            const isApproved = item.status === 'Approved';
                                            const isRequest = item.category === 'leave';
                                            const statusTone = isApproved ? 'success' : 'danger';
                                            const statusIcon = isApproved ? 'check_circle' : 'cancel';

                                            let iconTone = 'muted';
                                            if (isRequest) {
                                                if (item.type.includes('Nghỉ phép')) iconTone = 'primary';
                                                else if (item.type.includes('Nghỉ ốm')) iconTone = 'danger';
                                                else if (item.type.includes('Công tác')) iconTone = 'info';
                                                else iconTone = 'primary';
                                            } else {
                                                iconTone = 'warning';
                                            }

                                            return (
                                                <div key={item.id} className="p-5 active:bg-slate-50 dark:active:bg-dark-border/50 transition-colors">
                                                    <div className="flex gap-4">
                                                        <div className={`app-item-icon app-icon-tone-${iconTone}`}>
                                                            <span className="material-symbols-rounded">{isRequest ? (item.type.includes('Nghỉ phép') ? 'beach_access' : item.type.includes('Công tác') ? 'flight_takeoff' : item.type.includes('Nghỉ ốm') ? 'local_hospital' : 'description') : 'edit_document'}</span>
                                                        </div>

                                                        <div className="flex-1 min-w-0 pt-0.5">
                                                            <div className="flex justify-between items-start gap-2 mb-1">
                                                                <h4 className="font-black text-slate-800 dark:text-dark-text-primary text-sm leading-tight">
                                                                    {isRequest ? item.type : 'Giải trình công'}
                                                                </h4>
                                                                <div className={`request-status status-tone-${statusTone}`}>
                                                                    <span className="material-symbols-rounded text-base">{statusIcon}</span>
                                                                    {isApproved ? 'ĐÃ DUYỆT' : 'TỪ CHỐI'}
                                                                </div>
                                                            </div>

                                                            <div className="flex items-center gap-2 text-xs font-bold text-slate-400 dark:text-dark-text-secondary font-mono">
                                                                <span className="material-symbols-rounded text-base">calendar_month</span>
                                                                {renderDateRange(item.category === 'leave' ? item.from_date : item.date, item.category === 'leave' ? item.to_date : undefined)}
                                                            </div>
                                                        </div>
                                                    </div>

                                                    {item.manager_note && (
                                                        <div className={`notification-note notification-note-${statusTone}`}>
                                                            <span className="material-symbols-rounded text-base mt-0.5">comment</span>
                                                            <div>
                                                                <span className="font-black opacity-60 uppercase block mb-0.5 text-xxs tracking-wider">Phản hồi quản lý:</span>
                                                                {item.manager_note}
                                                            </div>
                                                        </div>
                                                    )}
                                                </div>
                                            );
                                        })}
                                    </div>
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
