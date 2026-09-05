import React, { useState, useEffect } from 'react';
import UserGuideModal from './UserGuideModal';
import ModalHeader from '@/shared/components/modals/ModalHeader';
import ConfirmDialog from '@/shared/components/modals/ConfirmDialog';
import { useModalAccessibility } from '@/shared/components/modals/useModalAccessibility';
import { getThemeMode, setThemeMode, type ThemeMode } from '@/shared/contexts/ThemeContext';
import { APP_INFO } from '@/shared/constants';

interface Props {
    isOpen: boolean;
    onClose: () => void;
}

interface SettingItemProps {
    icon: string;
    tone: 'primary' | 'info' | 'danger' | 'warning' | 'success' | 'muted';
    title: string;
    subtitle?: string;
    type?: 'link' | 'info';
    onClick?: () => void;
    href?: string;
}

const SettingItem: React.FC<SettingItemProps> = ({ icon, tone, title, subtitle, type = 'link', onClick, href }) => {
    const content = <>
        <div className={`app-item-icon app-icon-tone-${tone}`}>
            <span className="material-symbols-rounded" aria-hidden="true">{icon}</span>
        </div>
        <div className="flex-1 min-w-0">
            <h4 className="text-base font-bold text-slate-800 dark:text-dark-text-primary leading-tight group-hover:text-primary transition-colors">{title}</h4>
            {subtitle ? <p className="text-xs text-slate-400 dark:text-dark-text-secondary font-bold mt-0.5 truncate">{subtitle}</p> : null}
        </div>
        <div className="pl-2">
            {type === 'link' ? <span className="material-symbols-rounded text-slate-300 dark:text-dark-text-secondary text-xl" aria-hidden="true">chevron_right</span> : null}
            {type === 'info' ? <span className="material-symbols-rounded text-slate-300 dark:text-dark-text-secondary text-xl" aria-hidden="true">info</span> : null}
        </div>
    </>;

    if (href) return <a href={href} className="settings-item">{content}</a>;
    if (onClick) return <button type="button" onClick={onClick} className="settings-item">{content}</button>;
    return <div className="settings-item settings-item-static">{content}</div>;
};

const THEME_CHOICES: ReadonlyArray<{ mode: ThemeMode; icon: string; label: string }> = [
    { mode: 'system', icon: 'devices', label: 'Hệ thống' },
    { mode: 'light', icon: 'light_mode', label: 'Sáng' },
    { mode: 'dark', icon: 'dark_mode', label: 'Tối' },
];

const SettingsModal: React.FC<Props> = ({ isOpen, onClose }) => {
    const [selectedTheme, setSelectedTheme] = useState<ThemeMode>('system');
    const [isGuideOpen, setIsGuideOpen] = useState(false);
    const [showSupportModal, setShowSupportModal] = useState(false);
    const dialogRef = useModalAccessibility(isOpen, onClose);

    useEffect(() => {
        if (isOpen) {
            setSelectedTheme(getThemeMode());
            return;
        }
        setIsGuideOpen(false);
        setShowSupportModal(false);
    }, [isOpen]);

    const handleThemeChange = (mode: ThemeMode) => {
        setSelectedTheme(mode);
        setThemeMode(mode);
    };

    if (!isOpen) return null;

    return (
        <>
            <div ref={dialogRef} tabIndex={-1} className="app-modal-screen font-sans animate-slide-up" role="dialog" aria-modal="true" aria-label="Cài đặt">
                <ModalHeader title="Cài đặt" onClose={onClose} bgClass="bg-white dark:bg-dark-bg" />
                <div className="app-modal-content space-y-6">
                    <div className="space-y-3">
                        <h3 className="app-section-title"><span className="material-symbols-rounded" aria-hidden="true">tune</span> Tùy chọn chung</h3>
                        <div className="app-list-surface divide-y divide-slate-100 dark:divide-dark-border">
                            <SettingItem icon="palette" tone="primary" title="Giao diện" subtitle="Chọn theo thiết bị hoặc đặt thủ công" type="info" />
                            <div className="grid grid-cols-3 gap-2 p-3" role="group" aria-label="Chế độ giao diện">
                                {THEME_CHOICES.map(({ mode, icon, label }) => {
                                    const isSelected = selectedTheme === mode;
                                    return <button
                                        key={mode}
                                        type="button"
                                        aria-pressed={isSelected}
                                        onClick={() => handleThemeChange(mode)}
                                        className={`min-h-12 rounded-xl px-2 py-2 flex flex-col items-center justify-center gap-1 text-xs font-bold transition-colors ${isSelected ? 'bg-primary text-white' : 'bg-slate-50 dark:bg-dark-border/50 text-slate-600 dark:text-dark-text-primary hover:bg-primary/10'}`}
                                    >
                                        <span className="material-symbols-rounded text-xl" aria-hidden="true">{icon}</span>
                                        {label}
                                    </button>;
                                })}
                            </div>
                            <SettingItem icon="language" tone="info" title="Ngôn ngữ" subtitle="Hiện hỗ trợ Tiếng Việt" type="info" />
                        </div>
                    </div>

                    <div className="space-y-3">
                        <h3 className="app-section-title"><span className="material-symbols-rounded" aria-hidden="true">headset_mic</span> Trợ giúp & Hỗ trợ</h3>
                        <div className="app-list-surface divide-y divide-slate-100 dark:divide-dark-border">
                            <SettingItem icon="phone_in_talk" tone="primary" title="Tổng đài hỗ trợ" subtitle={APP_INFO.SUPPORT_PHONE_LABEL} onClick={() => setShowSupportModal(true)} />
                            <SettingItem href={`mailto:${APP_INFO.CONTACT_EMAIL}`} icon="send" tone="danger" title="Gửi phản hồi" subtitle="Báo lỗi hoặc góp ý tính năng" />
                            <SettingItem icon="menu_book" tone="muted" title="Hướng dẫn sử dụng" subtitle="Câu hỏi thường gặp (FAQ)" onClick={() => setIsGuideOpen(true)} />
                        </div>
                    </div>

                    <div className="space-y-3">
                        <h3 className="app-section-title"><span className="material-symbols-rounded" aria-hidden="true">info</span> Thông tin ứng dụng</h3>
                        <div className="app-list-surface divide-y divide-slate-100 dark:divide-dark-border">
                            <div className="p-6 flex flex-col items-center justify-center text-center gap-3 bg-gradient-to-b from-white/50 dark:from-dark-bg/50 to-slate-50 dark:to-dark-surface">
                                <div className="w-20 h-20 bg-white dark:bg-dark-bg rounded-lg border border-slate-100 dark:border-dark-border/50 p-3 mb-1 animate-scale-in"><img src={APP_INFO.LOGO_URL} className="w-full h-full object-contain" alt={APP_INFO.BRAND} /></div>
                                <div><h4 className="text-xl font-black text-slate-800 dark:text-dark-text-primary ">{APP_INFO.NAME}</h4><p className="text-xs text-slate-400 dark:text-dark-text-secondary font-bold uppercase tracking-wider bg-white dark:bg-dark-bg px-2 py-1 rounded-md inline-block mt-1">v{APP_INFO.VERSION}</p></div>
                            </div>
                            <SettingItem icon="shield" tone="success" title="Chính sách bảo mật" subtitle="Thông tin đang được hoàn thiện" type="info" />
                            <SettingItem icon="contract" tone="info" title="Điều khoản dịch vụ" subtitle="Thông tin đang được hoàn thiện" type="info" />
                        </div>
                    </div>
                </div>
            </div>
            <UserGuideModal isOpen={isGuideOpen} onClose={() => setIsGuideOpen(false)} />
            <ConfirmDialog isOpen={showSupportModal} title="Gọi tổng đài?" message={`Bạn có muốn gọi đến tổng đài ${APP_INFO.SUPPORT_PHONE_LABEL} để được hỗ trợ trực tiếp không?`} confirmLabel="Gọi ngay" onConfirm={() => { window.location.href = `tel:${APP_INFO.SUPPORT_PHONE}`; setShowSupportModal(false); }} onCancel={() => setShowSupportModal(false)} type="success" />
        </>
    );
};

export default SettingsModal;
