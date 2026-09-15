import React, { useMemo } from 'react';
import { formatDateString, toISODateString } from '@/core/utils/helpers';
import PullToRefresh from '@/shared/components/layout/PullToRefresh';
import type { WorkforceNotification } from '@/modules/tms/services/notifications';
import type { TabType } from './BottomNav';

interface Props {
    notifications: WorkforceNotification[];
    unreadCount: number;
    loading: boolean;
    onSwitchTab: (tab: TabType) => void;
    onMarkRead: (id: string) => Promise<boolean>;
    onMarkAllRead: () => Promise<boolean>;
    onRefresh: () => Promise<boolean | void>;
}

interface NotificationGroup {
    date: string;
    items: WorkforceNotification[];
}

function notificationPresentation(kind: string): { icon: string; tone: string; target: TabType } {
    switch (kind) {
        case 'REQUEST_PENDING':
        case 'REQUEST_OVERDUE':
            return { icon: 'fact_check', tone: 'warning', target: 'manager' };
        case 'REQUEST_DECIDED':
        case 'SWAP_CONSENT':
            return { icon: 'description', tone: 'primary', target: 'requests' };
        case 'SCHEDULE_CHANGED':
            return { icon: 'calendar_month', tone: 'info', target: 'calendar' };
        case 'CHECKIN_REMINDER':
        case 'CHECKOUT_REMINDER':
            return { icon: 'schedule', tone: 'success', target: 'home' };
        default:
            return { icon: 'notifications', tone: 'muted', target: 'home' };
    }
}

function notificationTime(value: string) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

const NotificationsModal: React.FC<Props> = ({
    notifications,
    unreadCount,
    loading,
    onSwitchTab,
    onMarkRead,
    onMarkAllRead,
    onRefresh,
}) => {
    const groups = useMemo(() => {
        const grouped = new Map<string, WorkforceNotification[]>();
        [...notifications]
            .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
            .forEach((item) => {
                const date = toISODateString(new Date(item.createdAt));
                grouped.set(date, [...(grouped.get(date) ?? []), item]);
            });
        return [...grouped].map(([date, items]): NotificationGroup => ({ date, items }));
    }, [notifications]);

    const openNotification = (notification: WorkforceNotification) => {
        if (!notification.readAt) void onMarkRead(notification.id);
        onSwitchTab(notificationPresentation(notification.kind).target);
    };

    return (
        <PullToRefresh onRefresh={onRefresh} className="page-bg flex flex-col font-sans overflow-y-auto h-full">
            <div className="employee-page employee-page-standard notifications-page animate-fade-in">
                <div className="ui-stack ui-stack-lg">
                    <div className="ui-label-row">
                        <span className="ui-label">Hộp thư thông báo</span>
                        {unreadCount > 0 ? (
                            <button type="button" className="ui-label-action" onClick={() => { void onMarkAllRead(); }}>
                                Đánh dấu đã đọc
                            </button>
                        ) : (
                            <span className="ui-pill ui-pill-muted">{notifications.length} thông báo</span>
                        )}
                    </div>

                    {notifications.length === 0 ? (
                        <div className="ui-empty" aria-busy={loading}>
                            <span className="material-symbols-rounded" aria-hidden="true">
                                {loading ? 'progress_activity' : 'notifications_off'}
                            </span>
                            <span className="ui-empty-title">{loading ? 'Đang tải thông báo…' : 'Chưa có thông báo'}</span>
                            <span className="ui-empty-text">Lịch làm việc, nhắc chấm công và kết quả duyệt sẽ hiển thị tại đây.</span>
                        </div>
                    ) : groups.map((group) => (
                        <div key={group.date}>
                            <div className="ui-daysep">
                                <span className="ui-label">{formatDateString(group.date)}</span>
                            </div>
                            <section className="ui-card ui-card-flush" aria-label={`Thông báo ngày ${formatDateString(group.date)}`}>
                                {group.items.map((notification) => {
                                    const presentation = notificationPresentation(notification.kind);
                                    const unread = !notification.readAt;
                                    return (
                                        <button
                                            type="button"
                                            key={notification.id}
                                            className={`notice-item notice-item-button ${unread ? 'notice-item-unread' : ''}`.trim()}
                                            onClick={() => openNotification(notification)}
                                            aria-label={`${unread ? 'Chưa đọc. ' : ''}${notification.title}`}
                                        >
                                            <span className="notice-head">
                                                <span className={`ui-tile ui-tile-soft ui-tone-${presentation.tone}`} aria-hidden="true">
                                                    <span className="material-symbols-rounded">{presentation.icon}</span>
                                                </span>
                                                <span className="notice-title">
                                                    <span className="notice-name">{notification.title}</span>
                                                    <span className="notice-date">{notificationTime(notification.createdAt)}</span>
                                                </span>
                                                {unread ? <span className="ui-pill ui-pill-primary">Mới</span> : null}
                                            </span>
                                            {notification.body ? <span className="notice-body">{notification.body}</span> : null}
                                        </button>
                                    );
                                })}
                            </section>
                        </div>
                    ))}
                </div>
            </div>
        </PullToRefresh>
    );
};

export default NotificationsModal;
