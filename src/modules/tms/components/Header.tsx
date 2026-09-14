import React, { useEffect, useRef, useState } from 'react';
import type { Employee } from '@/shared/types';
import { TabType } from './BottomNav';
import SettingsModal from './SettingsModal';
import Avatar from '@/shared/components/common/Avatar';
import IconButton from '@/shared/components/common/IconButton';

interface Props {
    user: Employee;
    activeTab: TabType;
    notificationCount: number;
    isOnline?: boolean;
    locationName?: string;
    onOpenProfile: () => void;
    onOpenNotifications: () => void;
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

const Header: React.FC<Props> = ({ user, activeTab, notificationCount, isOnline = true, locationName, onOpenProfile, onOpenNotifications, onContactSearch, canManage, onOpenManager, onOpenWorkspace }) => {
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const [isActionsOpen, setIsActionsOpen] = useState(false);
    const actionsRef = useRef<HTMLDivElement>(null);
    const identity = TAB_IDENTITY[activeTab] ?? { title: 'genAi TMS' };
    const isHome = activeTab === 'home';
    const title = isHome ? user.name : identity.title;
    const subtitle = isHome
        ? [user.position, locationName || user.center_id].filter(Boolean).join(' • ')
        : [user.name, user.position].filter(Boolean).join(' • ');

    useEffect(() => {
        setIsSettingsOpen(false);
        setIsActionsOpen(false);
    }, [activeTab]);

    useEffect(() => {
        if (!isActionsOpen) return undefined;

        const handlePointerDown = (event: PointerEvent) => {
            if (!actionsRef.current?.contains(event.target as Node)) setIsActionsOpen(false);
        };
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setIsActionsOpen(false);
        };

        document.addEventListener('pointerdown', handlePointerDown);
        document.addEventListener('keydown', handleKeyDown);
        return () => {
            document.removeEventListener('pointerdown', handlePointerDown);
            document.removeEventListener('keydown', handleKeyDown);
        };
    }, [isActionsOpen]);

    const openSettings = () => {
        setIsActionsOpen(false);
        setIsSettingsOpen(true);
    };

    return (
        <>
            <header className={`app-header ${isHome ? 'app-header-home' : ''}`.trim()}>
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
                                <h1 className="app-header-title">{title}</h1>
                                {isHome ? (
                                    <span className={`app-header-online ${isOnline ? '' : 'app-header-online-off'}`.trim()}>
                                        <i aria-hidden="true" />{isOnline ? 'Online' : 'Offline'}
                                    </span>
                                ) : identity.tag ? <span className="app-header-tag">{identity.tag}</span> : null}
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

                        <div className="app-header-menu" ref={actionsRef}>
                            <IconButton
                                icon="more_vert"
                                label="Mở menu tác vụ"
                                size="lg"
                                aria-expanded={isActionsOpen}
                                aria-haspopup="menu"
                                onClick={() => setIsActionsOpen((open) => !open)}
                            />

                            {isActionsOpen ? (
                                <div className="app-header-menu-popover" role="menu" aria-label="Tác vụ ứng dụng">
                                    {canManage && onOpenManager ? (
                                        <button
                                            type="button"
                                            role="menuitem"
                                            className={`app-header-menu-item ${activeTab === 'manager' ? 'app-header-menu-item-active' : ''}`.trim()}
                                            onClick={() => { setIsActionsOpen(false); onOpenManager(); }}
                                        >
                                            <span className="material-symbols-rounded" aria-hidden="true">speed</span>
                                            <span>Quản lý</span>
                                        </button>
                                    ) : null}

                                    {onOpenWorkspace ? (
                                        <button
                                            type="button"
                                            role="menuitem"
                                            className="app-header-menu-item"
                                            onClick={() => { setIsActionsOpen(false); onOpenWorkspace(); }}
                                        >
                                            <span className="material-symbols-rounded" aria-hidden="true">apps</span>
                                            <span>Chuyển không gian</span>
                                        </button>
                                    ) : null}

                                    <button type="button" role="menuitem" className="app-header-menu-item" onClick={openSettings}>
                                        <span className="material-symbols-rounded" aria-hidden="true">settings</span>
                                        <span>Cài đặt</span>
                                    </button>
                                </div>
                            ) : null}
                        </div>
                    </div>
                </div>
            </header>

            <SettingsModal isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} />
        </>
    );
};

export default Header;
