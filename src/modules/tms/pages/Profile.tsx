import React, { useMemo, useState, useRef, useEffect } from 'react';
import { Employee, LocationConfig } from '@/shared/types';
import { formatDateString, triggerHaptic } from '@/core/utils/helpers';
import { updateProfileAvatar, changePassword } from '@/modules/tms/services/employee';
import { APP_INFO, MANAGEMENT_ROLES, TMS_LIMITS, TMS_STORAGE } from '@/shared/constants';
import Avatar from '@/shared/components/common/Avatar';
import ImageCropper from '@/shared/components/common/ImageCropper';
import ConfirmDialog from '@/shared/components/modals/ConfirmDialog';
import ModalHeader from '@/shared/components/modals/ModalHeader';
import { useModalAccessibility } from '@/shared/components/modals/useModalAccessibility';

interface Props {
    user: Employee;
    locations: LocationConfig[];
    contacts: Employee[];
    onLogout: () => void;
    onUpdate: (updatedUser: Partial<Employee>) => void;
    onClose: () => void;
    onAlert: (title: string, msg: string, type: 'success' | 'error' | 'warning') => void;
    setShowImageCropper: (show: boolean) => void;
    onOpenManager?: () => void;
}

type ProfileTone = 'primary' | 'info' | 'success' | 'warning' | 'danger' | 'muted';

interface ProfileRowProps {
    icon: string;
    tone: ProfileTone;
    label: string;
    value?: React.ReactNode;
    isLink?: boolean;
    onClick?: () => void;
    isDestructive?: boolean;
}

const ProfileRow: React.FC<ProfileRowProps> = ({ icon, tone, label, value, isLink = false, onClick, isDestructive = false }) => {
    const content = <>
        <span className={`app-item-icon app-icon-tone-${tone}`}>
            <span className="material-symbols-rounded" aria-hidden="true">{icon}</span>
        </span>
        <span className="profile-row-content">
            {value ? <small>{label}</small> : null}
            <strong className={isDestructive ? 'status-tone-danger' : undefined}>{value || label}</strong>
        </span>
        {isLink ? <span className="profile-row-chevron material-symbols-rounded" aria-hidden="true">chevron_right</span> : null}
    </>;

    if (onClick) return <button type="button" onClick={() => { triggerHaptic('light'); onClick(); }} className="profile-row">{content}</button>;
    return <div className="profile-row">{content}</div>;
};

const TabProfile: React.FC<Props> = ({ user, locations, contacts, onLogout, onUpdate, onClose, onAlert, setShowImageCropper, onOpenManager }) => {
    const [showPwdModal, setShowPwdModal] = useState(false);
    const [loadingPwd, setLoadingPwd] = useState(false);
    const [passData, setPassData] = useState({ old: '', new: '', confirm: '' });
    const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
    const profileDialogRef = useModalAccessibility(true, onClose);
    const passwordDialogRef = useModalAccessibility(showPwdModal, () => setShowPwdModal(false), { closeOnEscape: !loadingPwd });

    const fileInputRef = useRef<HTMLInputElement>(null);
    const [uploading, setUploading] = useState(false);

    const [croppingImage, setCroppingImage] = useState<string | null>(null);

    useEffect(() => {
        setShowImageCropper(!!croppingImage);
    }, [croppingImage, setShowImageCropper]);

    const touchStart = useRef<{ x: number, y: number } | null>(null);
    const touchEnd = useRef<{ x: number, y: number } | null>(null);

    const canManage = useMemo(() => user && user.role && MANAGEMENT_ROLES.includes(user.role), [user]);

    const managerName = useMemo(() => {
        if (!user.direct_manager_id) return null;
        const mgr = contacts.find(c => c.employee_id === user.direct_manager_id);
        return mgr ? mgr.name : user.direct_manager_id;
    }, [user.direct_manager_id, contacts]);

    const userAddress = useMemo(() => {
        const loc = locations.find(l => l.center_id === user.center_id);
        return loc?.address || '';
    }, [user.center_id, locations]);

    const managedLocationNames = useMemo(() => {
        if (!user.managed_locations || !Array.isArray(user.managed_locations) || user.managed_locations.length === 0) return '';
        return user.managed_locations.map(id => {
            const loc = locations.find(l => l.center_id === id);
            return loc ? loc.location_name : id;
        }).join(', ');
    }, [user.managed_locations, locations]);

    const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        if (file.size > TMS_LIMITS.MAX_AVATAR_FILE_BYTES) {
            onAlert("Lỗi file", "File quá lớn. Vui lòng chọn ảnh khác.", 'error');
            return;
        }
        if (!TMS_STORAGE.AVATAR_MIME_TYPES.includes(file.type as typeof TMS_STORAGE.AVATAR_MIME_TYPES[number])) {
            onAlert("Lỗi file", "Chỉ hỗ trợ ảnh JPEG, PNG hoặc WebP.", 'error');
            return;
        }

        const reader = new FileReader();
        reader.onload = () => {
            if (typeof reader.result === 'string') {
                setCroppingImage(reader.result);
            }
        };
        reader.readAsDataURL(file);
        e.target.value = '';
    };

    const handleCropComplete = async (image: Blob) => {
        setUploading(true);
        try {
            const res = await updateProfileAvatar(image);
            if (res.success) {
                triggerHaptic('success');
                onUpdate({ avatar_url: res.avatarUrl, face_ref_url: res.avatarUrl });
                onAlert("Thành công", res.message, 'success');
            } else {
                triggerHaptic('error');
                onAlert("Lỗi", res.message, 'error');
            }
        } catch (err) {
            console.error(err);
            onAlert("Lỗi", "Lỗi xử lý ảnh.", 'error');
        } finally {
            setUploading(false);
            setCroppingImage(null);
        }
    };

    const handleUpdatePassword = async () => {
        if (!passData.old || !passData.new || !passData.confirm) {
            triggerHaptic('warning');
            onAlert("Thiếu thông tin", "Vui lòng điền đầy đủ thông tin!", 'warning');
            return;
        }
        if (passData.new !== passData.confirm) {
            triggerHaptic('warning');
            onAlert("Lỗi mật khẩu", "Mật khẩu mới không khớp!", 'warning');
            return;
        }
        if (passData.new.length < 6) {
            triggerHaptic('warning');
            onAlert("Mật khẩu yếu", "Mật khẩu mới phải có ít nhất 6 ký tự.", 'warning');
            return;
        }

        setLoadingPwd(true);
        const res = await changePassword(passData.old, passData.new);
        setLoadingPwd(false);

        if (res.success) {
            triggerHaptic('success');
            onAlert("Thành công", res.message, 'success');
            setShowPwdModal(false);
            setPassData({ old: '', new: '', confirm: '' });
        } else {
            triggerHaptic('error');
            onAlert("Lỗi", res.message, 'error');
        }
    };

    const onTouchStart = (e: React.TouchEvent) => {
        touchEnd.current = null;
        const touch = e.targetTouches[0];
        if (touch) touchStart.current = { x: touch.clientX, y: touch.clientY };
    };

    const onTouchMove = (e: React.TouchEvent) => {
        const touch = e.targetTouches[0];
        if (touch) touchEnd.current = { x: touch.clientX, y: touch.clientY };
    };

    const onTouchEnd = (e: React.TouchEvent) => {
        if (!touchStart.current || !touchEnd.current) return;

        const distanceX = touchStart.current.x - touchEnd.current.x;
        const distanceY = touchStart.current.y - touchEnd.current.y;

        if (Math.abs(distanceX) < Math.abs(distanceY)) {
            return;
        }

        if (distanceX > TMS_LIMITS.SWIPE_MODAL_CLOSE_PX) {
            e.stopPropagation();
            triggerHaptic('light');
            onClose();
        }
    };

    return (
        <div
            ref={profileDialogRef}
            tabIndex={-1}
            className="fixed inset-0 z-30 page-bg flex flex-col animate-slide-up transition-colors duration-300"
            role="dialog"
            aria-modal="true"
            aria-label="Hồ sơ cá nhân"
            onTouchStart={onTouchStart}
            onTouchMove={onTouchMove}
            onTouchEnd={onTouchEnd}
        >

            <div className="fixed top-0 left-0 w-full z-40">
                <ModalHeader
                    onClose={() => { triggerHaptic('light'); onClose(); }}
                    bgClass="bg-transparent border-none"
                />
            </div>

            <div className="employee-page employee-page-profile flex-1 overflow-y-auto no-scrollbar">
                <div className="animate-fade-in max-w-xl mx-auto w-full">

                    <div className="app-surface profile-identity-card">
                        <div className="app-hero-tint" aria-hidden="true"></div>
                        <div className="absolute top-0 left-0 w-full h-32 overflow-hidden pointer-events-none opacity-10">
                            <div className="absolute -top-10 -left-10 w-40 h-40 rounded-full border-8 border-primary"></div>
                            <div className="absolute -bottom-10 -right-10 w-60 h-60 rounded-full border-8 border-primary"></div>
                        </div>

                        <div className="relative z-10 flex flex-col items-center">
                            <div className="relative">
                                <button type="button" aria-label="Chọn ảnh đại diện" onClick={() => fileInputRef.current?.click()} className="profile-avatar-button group">
                                    <Avatar
                                        src={user.avatar_url || user.face_ref_url}
                                        name={user.name}
                                        className="w-full h-full rounded-full"
                                        textSize="text-4xl"
                                    />
                                    <span className="profile-avatar-overlay"><span className="material-symbols-rounded" aria-hidden="true">photo_camera</span></span>
                                </button>
                                <input
                                    type="file"
                                    ref={fileInputRef}
                                    className="hidden"
                                    accept="image/*"
                                    onChange={handleFileSelect}
                                />
                                {uploading && (
                                    <div className="absolute inset-0 flex items-center justify-center bg-white/50 dark:bg-black/50 rounded-full">
                                        <span className="material-symbols-rounded animate-spin text-primary">progress_activity</span>
                                    </div>
                                )}
                            </div>

                            <h2 className="text-2xl font-bold text-slate-800 dark:text-dark-text-primary leading-tight">{user.name}</h2>

                            <div className="flex gap-2 flex-wrap justify-center mt-3">
                                <span className="px-3 py-1.5 bg-primary/10 dark:bg-primary/20 border border-primary/20 dark:border-primary/30 rounded-full text-xxs font-extrabold text-primary dark:text-primary uppercase tracking-wide">{user.department}</span>
                                <span className="px-3 py-1.5 bg-secondary-purple/10 dark:bg-secondary-purple/20 border border-secondary-purple/20 dark:border-secondary-purple/30 rounded-full text-xxs font-extrabold text-secondary-purple dark:text-secondary-purple uppercase tracking-wide">{user.position}</span>
                            </div>
                        </div>
                    </div>

                    {canManage && (
                        <>
                            <h3 className="app-section-title app-section-title-spaced">
                                <span className="w-5 h-5 shrink-0 aspect-square rounded-full bg-primary/10 dark:bg-primary/20 flex items-center justify-center text-primary">
                                    <span className="material-symbols-rounded text-xs">speed</span>
                                </span>
                                Quản trị
                            </h3>
                            <div className="app-list-surface profile-section divide-y divide-slate-50 dark:divide-dark-border">
                                <ProfileRow
                                    icon="work"
                                    tone="primary"
                                    label="Quản lý nhân sự"
                                    isLink
                                    onClick={onOpenManager}
                                />
                            </div>
                        </>
                    )}

                    <h3 className="app-section-title app-section-title-spaced">
                        <span className="w-5 h-5 shrink-0 aspect-square rounded-full bg-primary/10 dark:bg-primary/20 flex items-center justify-center text-primary">
                            <span className="material-symbols-rounded text-xs">work</span>
                        </span>
                        Thông tin công việc
                    </h3>
                    <div className="app-list-surface profile-section divide-y divide-slate-50 dark:divide-dark-border">
                        <ProfileRow
                            icon="account_tree"
                            tone="primary"
                            label="Trung tâm phụ trách"
                            value={managedLocationNames}
                        />
                        {userAddress && (
                            <ProfileRow
                                icon="location_on"
                                tone="info"
                                label="Địa chỉ làm việc"
                                value={userAddress}
                            />
                        )}
                        <ProfileRow
                            icon="person"
                            tone="success"
                            label="Quản lý trực tiếp"
                            value={managerName || "Không có"}
                        />
                        <ProfileRow
                            icon="calendar_today"
                            tone="warning"
                            label="Ngày tham gia"
                            value={user.join_date ? formatDateString(user.join_date) : "--"}
                        />
                    </div>

                    <h3 className="app-section-title app-section-title-spaced">
                        <span className="w-5 h-5 shrink-0 aspect-square rounded-full bg-primary/10 dark:bg-primary/20 flex items-center justify-center text-primary">
                            <span className="material-symbols-rounded text-xs">badge</span>
                        </span>
                        Thông tin cá nhân
                    </h3>
                    <div className="app-list-surface profile-section divide-y divide-slate-50 dark:divide-dark-border">
                        <ProfileRow
                            icon="mail"
                            tone="primary"
                            label="Email"
                            value={user.email}
                        />
                        <ProfileRow
                            icon="call"
                            tone="success"
                            label="Số điện thoại"
                            value={user.phone ? String(user.phone) : 'Chưa cập nhật'}
                        />
                        <ProfileRow
                            icon="fingerprint"
                            tone="muted"
                            label="Thiết bị tin cậy"
                            value={user.trusted_device_id ? "Đã kích hoạt" : "Chưa kích hoạt"}
                        />
                    </div>

                    <h3 className="app-section-title app-section-title-spaced">
                        <span className="w-5 h-5 shrink-0 aspect-square rounded-full bg-primary/10 dark:bg-primary/20 flex items-center justify-center text-primary">
                            <span className="material-symbols-rounded text-xs">admin_panel_settings</span>
                        </span>
                        Tài khoản
                    </h3>
                    <div className="app-list-surface profile-section divide-y divide-slate-50 dark:divide-dark-border">
                        <ProfileRow
                            icon="key"
                            tone="warning"
                            label="Đổi mật khẩu"
                            isLink
                            onClick={() => setShowPwdModal(true)}
                        />
                        <ProfileRow
                            icon="logout"
                            tone="danger"
                            label="Đăng xuất"
                            isDestructive
                            onClick={() => {
                                triggerHaptic('medium');
                                setShowLogoutConfirm(true);
                            }}
                        />
                    </div>

                    <div className="text-center pb-8">
                        <p className="text-xxs font-extrabold text-slate-300 dark:text-dark-text-secondary/50 uppercase tracking-widest">{APP_INFO.NAME} v{APP_INFO.VERSION}</p>
                    </div>
                </div>
            </div>

            {showPwdModal && (
                <div className="fixed inset-0 z-50 bg-slate-900/60 dark:bg-dark-bg/80 backdrop-blur-sm flex items-center justify-center p-6 animate-fade-in">
                    <div ref={passwordDialogRef} tabIndex={-1} className="bg-white dark:bg-dark-surface w-full max-w-sm rounded-2xl p-6 border border-slate-100 dark:border-dark-border shadow-2xl animate-scale-in" role="dialog" aria-modal="true" aria-labelledby="profile-password-dialog-title" aria-describedby="profile-password-dialog-description" aria-busy={loadingPwd}>
                        <div className="text-center mb-6">
                            <div className="w-16 h-16 bg-secondary-yellow/10 dark:bg-secondary-yellow/20 text-secondary-yellow border border-secondary-yellow/20 dark:border-secondary-yellow/30 rounded-full flex items-center justify-center mx-auto mb-4">
                                <span className="material-symbols-rounded text-3xl">lock</span>
                            </div>
                            <h3 id="profile-password-dialog-title" className="text-xl font-bold text-slate-800 dark:text-dark-text-primary">Đổi mật khẩu</h3>
                            <p id="profile-password-dialog-description" className="text-xs text-slate-500 dark:text-dark-text-secondary font-bold mt-1 uppercase tracking-wide">Cập nhật mật khẩu bảo vệ tài khoản</p>
                        </div>

                        <div className="space-y-4">
                            <div>
                                <label className="input-label" htmlFor="profile-current-password">Mật khẩu hiện tại</label>
                                <input
                                    id="profile-current-password"
                                    type="password"
                                    autoComplete="current-password"
                                    className="input-field"
                                    placeholder="••••••••"
                                    value={passData.old}
                                    onChange={e => setPassData({ ...passData, old: e.target.value })}
                                />
                            </div>
                            <div>
                                <label className="input-label" htmlFor="profile-new-password">Mật khẩu mới</label>
                                <input
                                    id="profile-new-password"
                                    type="password"
                                    autoComplete="new-password"
                                    aria-describedby="profile-new-password-hint"
                                    className="input-field"
                                    placeholder="••••••••"
                                    value={passData.new}
                                    onChange={e => setPassData({ ...passData, new: e.target.value })}
                                />
                                <p id="profile-new-password-hint" className="mt-1.5 text-xs text-slate-500 dark:text-dark-text-secondary">Ít nhất 6 ký tự.</p>
                            </div>
                            <div>
                                <label className="input-label" htmlFor="profile-confirm-password">Xác nhận mật khẩu</label>
                                <input
                                    id="profile-confirm-password"
                                    type="password"
                                    autoComplete="new-password"
                                    className="input-field"
                                    placeholder="••••••••"
                                    value={passData.confirm}
                                    onChange={e => setPassData({ ...passData, confirm: e.target.value })}
                                />
                            </div>
                        </div>

                        <div className="flex gap-3 mt-8">
                            <button
                                type="button"
                                onClick={() => setShowPwdModal(false)}
                                className="flex-1 py-3.5 bg-slate-100 dark:bg-dark-border/50 text-slate-600 dark:text-dark-text-primary font-bold text-sm rounded-2xl hover:bg-slate-200 dark:hover:bg-dark-border transition-colors uppercase tracking-wide cursor-pointer"
                            >
                                Hủy
                            </button>
                            <button
                                type="button"
                                onClick={handleUpdatePassword}
                                disabled={loadingPwd}
                                className="app-interactive-card flex-1 py-3.5 bg-primary text-neutral-white font-bold text-sm rounded-2xl hover:bg-primary/90 transition-all disabled:opacity-70 disabled:active:scale-100 uppercase tracking-wide flex items-center justify-center gap-2 cursor-pointer"
                            >
                                {loadingPwd ? <span className="material-symbols-rounded animate-spin">progress_activity</span> : 'Lưu thay đổi'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            <ConfirmDialog
                isOpen={showLogoutConfirm}
                title="Đăng xuất?"
                message="Bạn có chắc chắn muốn đăng xuất khỏi tài khoản này?"
                confirmLabel="Đăng xuất"
                onConfirm={onLogout}
                onCancel={() => setShowLogoutConfirm(false)}
                type="danger"
            />

            {croppingImage && (
                <ImageCropper
                    imageSrc={croppingImage}
                    onCancel={() => { setCroppingImage(null); if (fileInputRef.current) fileInputRef.current.value = ''; }}
                    onCropComplete={handleCropComplete}
                />
            )}
        </div>
    );
};

export default TabProfile;
