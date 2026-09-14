import React, { useState, useEffect } from 'react';
import UserGuideModal from './UserGuideModal';
import ModalHeader from '@/shared/components/modals/ModalHeader';
import ConfirmDialog from '@/shared/components/modals/ConfirmDialog';
import { useModalAccessibility } from '@/shared/components/modals/useModalAccessibility';
import { getThemeMode, setThemeMode, type ThemeMode } from '@/shared/contexts/ThemeContext';
import { getFeedbackPrefs, setFeedbackPrefs, type FeedbackPrefs } from '@/core/utils/helpers';
import { APP_INFO } from '@/shared/constants';
import { useModalSwipeBack } from '@/shared/hooks/useModalSwipeBack';

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
    const content = (
        <>
            <span className={`ui-row-icon ui-tone-${tone}`} aria-hidden="true">
                <span className="material-symbols-rounded">{icon}</span>
            </span>
            <span className="ui-row-body">
                <span className="ui-row-label">{title}</span>
                {subtitle ? <span className="ui-row-value">{subtitle}</span> : null}
            </span>
            {type === 'link' ? <span className="material-symbols-rounded ui-row-trail" aria-hidden="true">chevron_right</span> : null}
        </>
    );

    const className = 'ui-row ui-row-action';
    if (href) return <a href={href} className={className}>{content}</a>;
    if (onClick) return <button type="button" onClick={onClick} className={className}>{content}</button>;
    return <div className={className}>{content}</div>;
};

const SettingToggle: React.FC<{
    icon: string;
    tone: SettingItemProps['tone'];
    title: string;
    subtitle: string;
    checked: boolean;
    onChange: (next: boolean) => void;
}> = ({ icon, tone, title, subtitle, checked, onChange }) => (
    <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className="ui-row ui-row-action"
    >
        <span className={`ui-row-icon ui-tone-${tone}`} aria-hidden="true">
            <span className="material-symbols-rounded">{icon}</span>
        </span>
        <span className="ui-row-body">
            <span className="ui-row-label">{title}</span>
            <span className="ui-row-value">{subtitle}</span>
        </span>
        <span className={`ui-switch ${checked ? 'ui-switch-on' : ''}`.trim()} aria-hidden="true"><span /></span>
    </button>
);

const THEME_CHOICES: ReadonlyArray<{ mode: ThemeMode; icon: string; label: string }> = [
    { mode: 'system', icon: 'devices', label: 'Hệ thống' },
    { mode: 'light', icon: 'light_mode', label: 'Sáng' },
    { mode: 'dark', icon: 'dark_mode', label: 'Tối' },
];

const SettingsModal: React.FC<Props> = ({ isOpen, onClose }) => {
    const [selectedTheme, setSelectedTheme] = useState<ThemeMode>('system');
    const [feedback, setFeedback] = useState<FeedbackPrefs>(() => getFeedbackPrefs());
    const [isGuideOpen, setIsGuideOpen] = useState(false);
    const [showSupportModal, setShowSupportModal] = useState(false);
    const dialogRef = useModalAccessibility(isOpen, onClose);
    const swipeBackHandlers = useModalSwipeBack(onClose, isGuideOpen || showSupportModal);

    useEffect(() => {
        if (isOpen) {
            setSelectedTheme(getThemeMode());
            setFeedback(getFeedbackPrefs());
            return;
        }
        setIsGuideOpen(false);
        setShowSupportModal(false);
    }, [isOpen]);

    const handleThemeChange = (mode: ThemeMode) => {
        setSelectedTheme(mode);
        setThemeMode(mode);
    };

    const handleFeedbackChange = (patch: Partial<FeedbackPrefs>) => {
        setFeedback(setFeedbackPrefs(patch));
    };

    if (!isOpen) return null;

    return (
        <>
            <div ref={dialogRef} tabIndex={-1} className="app-modal-screen app-modal-screen-solid font-sans animate-slide-up" role="dialog" aria-modal="true" aria-label="Cài đặt" data-swipe-surface="modal" {...swipeBackHandlers}>
                <div className="app-modal-header-layer">
                    <ModalHeader title="Cài đặt" subtitle={`${APP_INFO.NAME} · v${APP_INFO.VERSION}`} onClose={onClose} />
                </div>

                <div className="app-modal-content no-scrollbar">
                    <div className="ui-stack ui-stack-lg animate-fade-in">
                        {/* Appearance ------------------------------------- */}
                        <div>
                            <div className="ui-label-row"><span className="ui-label">Tùy chọn chung</span></div>
                            <section className="ui-card ui-card-flush">
                                <div className="ui-row">
                                    <span className="ui-row-icon ui-tone-primary" aria-hidden="true">
                                        <span className="material-symbols-rounded">palette</span>
                                    </span>
                                    <span className="ui-row-body">
                                        <span className="ui-row-label">Giao diện</span>
                                        <span className="ui-row-value">Theo thiết bị hoặc đặt thủ công</span>
                                    </span>
                                </div>
                                <div className="settings-segment-row">
                                    <div className="ui-segment" role="group" aria-label="Chế độ giao diện">
                                        {THEME_CHOICES.map(({ mode, icon, label }) => {
                                            const isSelected = selectedTheme === mode;
                                            return (
                                                <button
                                                    key={mode}
                                                    type="button"
                                                    aria-pressed={isSelected}
                                                    onClick={() => handleThemeChange(mode)}
                                                    className={`ui-segment-option ${isSelected ? 'ui-segment-option-active' : ''}`.trim()}
                                                >
                                                    <span className="material-symbols-rounded" aria-hidden="true">{icon}</span>
                                                    {label}
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>
                                <SettingItem icon="language" tone="info" title="Ngôn ngữ" subtitle="Hiện hỗ trợ Tiếng Việt" type="info" />
                            </section>
                        </div>

                        {/* Feedback --------------------------------------- */}
                        <div>
                            <div className="ui-label-row"><span className="ui-label">Phản hồi thao tác</span></div>
                            <section className="ui-card ui-card-flush">
                                <SettingToggle
                                    icon="vibration"
                                    tone="primary"
                                    title="Rung phản hồi"
                                    subtitle="Rung nhẹ khi chấm công và thao tác chính"
                                    checked={feedback.haptics}
                                    onChange={(next) => handleFeedbackChange({ haptics: next })}
                                />
                                <SettingToggle
                                    icon="volume_up"
                                    tone="info"
                                    title="Âm báo"
                                    subtitle="Phát âm xác nhận khi thao tác thành công hoặc lỗi"
                                    checked={feedback.sound}
                                    onChange={(next) => handleFeedbackChange({ sound: next })}
                                />
                            </section>
                        </div>

                        {/* Help ------------------------------------------- */}
                        <div>
                            <div className="ui-label-row"><span className="ui-label">Trợ giúp &amp; hỗ trợ</span></div>
                            <section className="ui-card ui-card-flush">
                                <SettingItem icon="phone_in_talk" tone="primary" title="Tổng đài hỗ trợ" subtitle={APP_INFO.SUPPORT_PHONE_LABEL} onClick={() => setShowSupportModal(true)} />
                                <SettingItem href={`mailto:${APP_INFO.CONTACT_EMAIL}`} icon="send" tone="success" title="Gửi phản hồi" subtitle="Báo lỗi hoặc góp ý tính năng" />
                                <SettingItem icon="menu_book" tone="info" title="Hướng dẫn sử dụng" subtitle="Câu hỏi thường gặp (FAQ)" onClick={() => setIsGuideOpen(true)} />
                            </section>
                        </div>

                        {/* About ------------------------------------------ */}
                        <div>
                            <div className="ui-label-row"><span className="ui-label">Thông tin ứng dụng</span></div>
                            <section className="ui-card ui-card-flush">
                                <div className="settings-about">
                                    <img src={APP_INFO.LOGO_URL} className="settings-about-logo" alt={APP_INFO.BRAND} />
                                    <span className="settings-about-name">{APP_INFO.NAME}</span>
                                    <span className="ui-pill ui-pill-muted">v{APP_INFO.VERSION}</span>
                                </div>
                                <SettingItem icon="shield" tone="success" title="Chính sách bảo mật" subtitle="Thông tin đang được hoàn thiện" type="info" />
                                <SettingItem icon="contract" tone="info" title="Điều khoản dịch vụ" subtitle="Thông tin đang được hoàn thiện" type="info" />
                            </section>
                        </div>

                        <div className="ui-footer">
                            <span className="ui-footer-line">
                                <span className="material-symbols-rounded" aria-hidden="true">verified_user</span>
                                {APP_INFO.NAME} · v{APP_INFO.VERSION}
                            </span>
                            <span className="ui-footer-sub">Bản quyền thuộc về {APP_INFO.BRAND}</span>
                        </div>
                    </div>
                </div>
            </div>

            <UserGuideModal isOpen={isGuideOpen} onClose={() => setIsGuideOpen(false)} />
            <ConfirmDialog
                isOpen={showSupportModal}
                title="Gọi tổng đài?"
                message={<>Gọi đến <strong>{APP_INFO.SUPPORT_PHONE_LABEL}</strong> để được hỗ trợ trực tiếp.</>}
                confirmLabel="Gọi ngay"
                onConfirm={() => { window.location.href = `tel:${APP_INFO.SUPPORT_PHONE}`; setShowSupportModal(false); }}
                onCancel={() => setShowSupportModal(false)}
                type="success"
            />
        </>
    );
};

export default SettingsModal;
