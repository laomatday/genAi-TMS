import React, { useState, useEffect } from 'react';
import type { Employee } from '@/shared/types';
import { TabType } from './BottomNav';
import SettingsModal from './SettingsModal';
import Avatar from '@/shared/components/common/Avatar';
import IconButton from '@/shared/components/common/IconButton';

interface Props {
    user: Employee;
    activeTab: TabType;
    notificationCount: number;
    onOpenProfile: () => void;
    onOpenNotifications: () => void;
    onCreateRequest?: () => void;
    onContactSearch?: () => void;
    canManage?: boolean;
    onOpenManager?: () => void;
    onOpenWorkspace?: () => void;
}

/** Each tab carries its own title and a short tag so the header always says
 *  where you are — the mobile screens have no other place for a page name. */
const TAB_IDENTITY: Partial<Record<TabType, { title: string; tag?: string }>> = {
    home: { title: 'Trang chủ' },
    history: { title: 'Chấm công', tag: 'Nhật ký' },
    requests: { title: 'Đề xuất', tag: 'Đơn từ' },
    calendar: { title: 'Lịch làm việc', tag: 'Team' },
    contacts: { title: 'Danh bạ', tag: 'Nội bộ' },
    manager: { title: 'Quản lý', tag: 'Lead' },
    notifications: { title: 'Thông báo' },
};

const Header: React.FC<Props> = ({ user, activeTab, notificationCount, onOpenProfile, onOpenNotifications, onCreateRequest, onContactSearch, canManage, onOpenManager, onOpenWorkspace }) => {
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const identity = TAB_IDENTITY[activeTab] ?? { title: 'genAi TMS' };
    const subtitle = [user.name, user.position].filter(Boolean).join(' • ');

    useEffect(() => {
        setIsSettingsOpen(false);
    }, [activeTab]);

    return (
        <>
            <header className="app-header">
                <div className="app-header-inner">
                    <div className="app-header-identity">
                        <button
                            type="button"
                            className="app-header-profile"
                            aria-label={`Mở hồ sơ của ${user.name}`}
                            title="Hồ sơ"
                            onClick={onOpenProfile}
                        >
                            <Avatar
                                src={user.avatar_url || user.face_ref_url}
                                name={user.name}
                                className="app-header-avatar"
                            />
                            <span
                                className={`app-header-presence ${user.status === 'Active' ? '' : 'app-header-presence-off'}`.trim()}
                                aria-hidden="true"
                            />
                        </button>

                        <div className="app-header-titles">
                            <div className="app-header-title-row">
                                <h1 className="app-header-title">{identity.title}</h1>
                                {identity.tag ? <span className="app-header-tag">{identity.tag}</span> : null}
                            </div>
                            <p className="app-header-subtitle">{subtitle}</p>
                        </div>
                    </div>

                    <div className="app-header-actions">
                        {activeTab === 'contacts' && onContactSearch && (
                            <IconButton
                                icon="search"
                                label="Tìm kiếm"
                                size="lg"
                                onClick={onContactSearch}
                            />
                        )}

                        {activeTab === 'requests' && onCreateRequest && (
                            <IconButton
                                icon="add"
                                label="Tạo yêu cầu"
                                size="lg"
                                tone="primary"
                                onClick={onCreateRequest}
                            />
                        )}

                        {canManage && onOpenManager && (
                            <IconButton
                                icon="speed"
                                label="Quản lý"
                                size="lg"
                                tone={activeTab === 'manager' ? 'primary' : 'default'}
                                onClick={onOpenManager}
                            />
                        )}

                        {onOpenWorkspace && (
                            <IconButton
                                icon="apps"
                                label="Chuyển không gian"
                                size="lg"
                                onClick={onOpenWorkspace}
                            />
                        )}

                        <span className="app-header-action">
                            <IconButton
                                icon="notifications"
                                label={notificationCount > 0 ? `Thông báo, ${notificationCount} chưa đọc` : 'Thông báo'}
                                size="lg"
                                tone={activeTab === 'notifications' ? 'primary' : 'default'}
                                onClick={onOpenNotifications}
                            />
                            {notificationCount > 0 ? (
                                <span className="app-header-badge" aria-hidden="true">
                                    {notificationCount > 9 ? '9+' : notificationCount}
                                </span>
                            ) : null}
                        </span>

                        <IconButton
                            icon="more_vert"
                            label="Mở cài đặt"
                            size="lg"
                            onClick={() => setIsSettingsOpen(true)}
                        />
                    </div>
                </div>
            </header>

            <SettingsModal isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} />
        </>
    );
};

export default Header;
