import React, { useMemo, useState, useRef, useEffect } from 'react';
import { Employee, LocationConfig } from '@/shared/types';
import { formatDateString, triggerHaptic } from '@/core/utils/helpers';
import { updateProfileAvatar, changePassword } from '@/modules/tms/services/employee';
import { APP_INFO, MANAGEMENT_ROLES, TMS_LIMITS, TMS_STORAGE } from '@/shared/constants';
import { useToast } from '@/shared/contexts/useToast';
import Avatar from '@/shared/components/common/Avatar';
import ImageCropper from '@/shared/components/common/ImageCropper';
import ConfirmDialog from '@/shared/components/modals/ConfirmDialog';
import ModalHeader from '@/shared/components/modals/ModalHeader';
import { useModalAccessibility } from '@/shared/components/modals/useModalAccessibility';
import { useModalSwipeBack } from '@/shared/hooks/useModalSwipeBack';

interface Props {
    user: Employee;
    locations: LocationConfig[];
    locationNames: Record<string, string>;
    contacts: Employee[];
    /** On-time ratio over the loaded timesheet window. Null when nothing is
     *  recorded yet — the tile then says so instead of showing a made-up 0%. */
    punctuality?: { rate: number; sample: number } | null;
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
    trailing?: React.ReactNode;
    onClick?: () => void;
    /** Action rows put the action first and the explanation underneath, the
     *  opposite of a data row where the caption introduces a value. */
    isAction?: boolean;
    isDestructive?: boolean;
}

const ProfileRow: React.FC<ProfileRowProps> = ({ icon, tone, label, value, trailing, onClick, isAction = false, isDestructive = false }) => {
    const content = (
        <>
            <span className={`ui-row-icon ui-tone-${isDestructive ? 'danger' : tone}`} aria-hidden="true">
                <span className="material-symbols-rounded">{icon}</span>
            </span>
            <span className="ui-row-body">
                <span className="ui-row-label">{label}</span>
                {value ? <span className="ui-row-value">{value}</span> : null}
            </span>
            {trailing ? <span className="ui-row-trail">{trailing}</span> : null}
        </>
    );

    const className = `ui-row ${isAction ? 'ui-row-action' : ''} ${isDestructive ? 'ui-row-danger' : ''}`.replace(/\s+/g, ' ').trim();

    if (onClick) {
        return (
            <button type="button" onClick={() => { triggerHaptic('light'); onClick(); }} className={className}>
                {content}
            </button>
        );
    }
    return <div className={className}>{content}</div>;
};

/** Whole years, one decimal, from the employment start date. */
function seniorityYears(joinDate?: string) {
    if (!joinDate) return null;
    const start = new Date(`${joinDate.slice(0, 10)}T00:00:00`);
    if (Number.isNaN(start.getTime())) return null;
    const years = (Date.now() - start.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
    return years < 0 ? null : years;
}

const TabProfile: React.FC<Props> = ({ user, locations, locationNames, contacts, punctuality, onLogout, onUpdate, onClose, onAlert, setShowImageCropper, onOpenManager }) => {
    const [showPwdModal, setShowPwdModal] = useState(false);
    const [loadingPwd, setLoadingPwd] = useState(false);
    const [passData, setPassData] = useState({ old: '', new: '', confirm: '' });
    const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
    const profileDialogRef = useModalAccessibility(true, onClose);
    const passwordDialogRef = useModalAccessibility(showPwdModal, () => setShowPwdModal(false), { closeOnEscape: !loadingPwd });
    const { showToast } = useToast();

    const fileInputRef = useRef<HTMLInputElement>(null);
    const [uploading, setUploading] = useState(false);

    const [croppingImage, setCroppingImage] = useState<string | null>(null);
    const swipeBackHandlers = useModalSwipeBack(onClose, showPwdModal || showLogoutConfirm || Boolean(croppingImage));

    useEffect(() => {
        setShowImageCropper(!!croppingImage);
    }, [croppingImage, setShowImageCropper]);

    const canManage = useMemo(() => user && user.role && MANAGEMENT_ROLES.includes(user.role), [user]);

    const manager = useMemo(() => {
        if (!user.direct_manager_id) return null;
        return contacts.find(c => c.employee_id === user.direct_manager_id) || null;
    }, [user.direct_manager_id, contacts]);

    const userAddress = useMemo(() => {
        const loc = locations.find(l => l.center_id === user.center_id);
        return loc?.address || '';
    }, [user.center_id, locations]);

    const homeCenterName = useMemo(
        () => (user.center_id ? locationNames[user.center_id] || user.center_id : ''),
        [user.center_id, locationNames],
    );

    const managedLocationNames = useMemo(() => {
        if (!user.managed_locations || !Array.isArray(user.managed_locations) || user.managed_locations.length === 0) return '';
        return user.managed_locations.map(id => locationNames[id] || id).join(', ');
    }, [user.managed_locations, locationNames]);

    const seniority = useMemo(() => seniorityYears(user.join_date), [user.join_date]);

    const handleCopyEmail = async () => {
        if (!user.email) return;
        triggerHaptic('light');
        try {
            await navigator.clipboard.writeText(user.email);
            showToast({ title: 'Đã sao chép', body: user.email, type: 'success' });
        } catch {
            showToast({ title: 'Không sao chép được', body: 'Trình duyệt đã chặn quyền truy cập clipboard.', type: 'error' });
        }
    };

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
        if (passData.new.length < TMS_LIMITS.ACCOUNT_PASSWORD_MIN_LENGTH) {
            triggerHaptic('warning');
            onAlert("Mật khẩu yếu", `Mật khẩu mới phải có ít nhất ${TMS_LIMITS.ACCOUNT_PASSWORD_MIN_LENGTH} ký tự.`, 'warning');
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

    const isOnline = user.status === 'Active';
    const deviceBound = Boolean(user.trusted_device_id);

    return (
        <div
            ref={profileDialogRef}
            tabIndex={-1}
            className="app-modal-swipe-surface fixed inset-0 z-30 page-bg flex flex-col animate-slide-up transition-colors duration-300"
            role="dialog"
            aria-modal="true"
            aria-label="Hồ sơ cá nhân"
            data-swipe-surface="modal"
            {...swipeBackHandlers}
        >
            <div className="fixed top-0 left-0 w-full z-40">
                <ModalHeader
                    title="Hồ sơ cá nhân"
                    onClose={() => { triggerHaptic('light'); onClose(); }}
                />
            </div>

            <div className="employee-page employee-page-profile flex-1 overflow-y-auto no-scrollbar">
                <div className="ui-stack animate-fade-in max-w-xl mx-auto w-full">

                    {/* Identity ------------------------------------------------ */}
                    <section className="profile-hero">
                        <div className="profile-hero-cover">
                            <span className="profile-hero-chip">
                                <span className="material-symbols-rounded" aria-hidden="true">corporate_fare</span>
                                {APP_INFO.PRODUCT_NAME}
                            </span>
                            <span className="profile-hero-chip profile-hero-chip-ghost">{user.employee_id}</span>
                        </div>

                        <div className="profile-hero-body">
                            <div className="profile-hero-avatar">
                                <Avatar
                                    src={user.avatar_url || user.face_ref_url}
                                    name={user.name}
                                    className="w-full h-full rounded-full"
                                    textSize="text-3xl"
                                />
                                <button
                                    type="button"
                                    className="profile-hero-camera"
                                    aria-label="Đổi ảnh đại diện"
                                    onClick={() => fileInputRef.current?.click()}
                                >
                                    <span className="material-symbols-rounded" aria-hidden="true">photo_camera</span>
                                </button>
                                <input
                                    type="file"
                                    ref={fileInputRef}
                                    className="hidden"
                                    accept={TMS_STORAGE.AVATAR_MIME_TYPES.join(',')}
                                    onChange={handleFileSelect}
                                />
                                {uploading && (
                                    <div className="profile-hero-uploading" role="status">
                                        <span className="material-symbols-rounded animate-spin" aria-hidden="true">progress_activity</span>
                                    </div>
                                )}
                            </div>

                            <h2 className="profile-hero-name">
                                {user.name}
                                {deviceBound ? (
                                    <span className="material-symbols-rounded profile-hero-verified" title="Thiết bị đã xác thực" aria-label="Thiết bị đã xác thực">verified</span>
                                ) : null}
                            </h2>

                            <div className="profile-hero-tags">
                                {user.position ? <span className="ui-pill ui-pill-muted">{user.position}</span> : null}
                                {user.department ? <span className="ui-pill ui-pill-muted">{user.department}</span> : null}
                            </div>

                            <span className={`ui-pill ${isOnline ? 'ui-pill-success' : 'ui-pill-muted'}`}>
                                <span className="ui-pill-dot" aria-hidden="true" />
                                {isOnline ? 'Đang hoạt động' : 'Tài khoản tạm ngưng'}
                                {user.role ? ` • ${user.role}` : ''}
                            </span>
                        </div>
                    </section>

                    {/* Key figures --------------------------------------------- */}
                    <div className="ui-metrics">
                        <div className="ui-metric">
                            <span className="ui-metric-head">
                                <span>Phép năm</span>
                                <span className="material-symbols-rounded ui-tone-success" aria-hidden="true">beach_access</span>
                            </span>
                            <span className="ui-metric-value">
                                {user.annual_leave_balance ?? 0}
                                <span className="ui-metric-unit">ngày</span>
                            </span>
                            <span className="ui-metric-foot">Số dư còn lại</span>
                        </div>

                        <div className="ui-metric">
                            <span className="ui-metric-head">
                                <span>Đúng giờ</span>
                                <span className="material-symbols-rounded ui-tone-primary" aria-hidden="true">timer</span>
                            </span>
                            <span className="ui-metric-value ui-tone-primary">
                                {punctuality ? punctuality.rate.toFixed(1) : '--'}
                                <span className="ui-metric-unit">%</span>
                            </span>
                            <span className="ui-metric-foot">
                                {punctuality ? `${punctuality.sample} ca gần đây` : 'Chưa có dữ liệu'}
                            </span>
                        </div>

                        <div className="ui-metric">
                            <span className="ui-metric-head">
                                <span>Thâm niên</span>
                                <span className="material-symbols-rounded ui-tone-warning" aria-hidden="true">calendar_month</span>
                            </span>
                            <span className="ui-metric-value">
                                {seniority !== null ? seniority.toFixed(1) : '--'}
                                <span className="ui-metric-unit">năm</span>
                            </span>
                            <span className="ui-metric-foot">
                                {user.join_date ? `Từ ${formatDateString(user.join_date)}` : 'Chưa có ngày vào làm'}
                            </span>
                        </div>
                    </div>

                    {/* Manager workspace --------------------------------------- */}
                    {canManage && onOpenManager && (
                        <button type="button" className="ui-banner" onClick={() => { triggerHaptic('light'); onOpenManager(); }}>
                            <span className="ui-banner-icon" aria-hidden="true">
                                <span className="material-symbols-rounded">shield_person</span>
                            </span>
                            <span className="ui-banner-body">
                                <span className="ui-banner-title">Không gian quản lý</span>
                                <span className="ui-banner-sub">Duyệt đơn từ &amp; chấm công đội ngũ</span>
                            </span>
                            <span className="ui-banner-flag">{user.role}</span>
                            <span className="material-symbols-rounded" aria-hidden="true">chevron_right</span>
                        </button>
                    )}

                    {/* Work ---------------------------------------------------- */}
                    <div>
                        <div className="ui-label-row">
                            <span className="ui-label">Thông tin công việc</span>
                        </div>
                        <div className="ui-card ui-card-flush profile-card">
                            <ProfileRow
                                icon="account_tree"
                                tone="primary"
                                label="Phòng ban & vị trí"
                                value={[user.department, user.position].filter(Boolean).join(' • ') || 'Chưa cập nhật'}
                            />
                            <ProfileRow
                                icon="corporate_fare"
                                tone="info"
                                label="Trung tâm làm việc"
                                value={managedLocationNames || homeCenterName || 'Chưa cập nhật'}
                            />
                            {userAddress && (
                                <ProfileRow
                                    icon="location_on"
                                    tone="success"
                                    label="Địa chỉ làm việc"
                                    value={userAddress}
                                />
                            )}
                            <ProfileRow
                                icon="supervisor_account"
                                tone="warning"
                                label="Quản lý trực tiếp"
                                value={manager?.name || user.direct_manager_id || 'Không có'}
                                trailing={manager?.position ? <span className="ui-pill ui-pill-muted">{manager.position}</span> : undefined}
                            />
                        </div>
                    </div>

                    {/* Contact & device ---------------------------------------- */}
                    <div>
                        <div className="ui-label-row">
                            <span className="ui-label">Liên hệ &amp; thiết bị</span>
                        </div>
                        <div className="ui-card ui-card-flush profile-card">
                            <ProfileRow
                                icon="alternate_email"
                                tone="primary"
                                label="Email công vụ"
                                value={user.email || 'Chưa cập nhật'}
                                trailing={user.email ? (
                                    <button type="button" className="ui-person-action" aria-label="Sao chép email" onClick={handleCopyEmail}>
                                        <span className="material-symbols-rounded" aria-hidden="true">content_copy</span>
                                    </button>
                                ) : undefined}
                            />
                            <ProfileRow
                                icon="call"
                                tone="success"
                                label="Số điện thoại"
                                value={user.phone ? String(user.phone) : 'Chưa cập nhật'}
                                trailing={user.phone ? (
                                    <a className="ui-person-action ui-person-action-accent" href={`tel:${user.phone}`} aria-label="Gọi số điện thoại này">
                                        <span className="material-symbols-rounded" aria-hidden="true">phone_in_talk</span>
                                    </a>
                                ) : undefined}
                            />
                            <ProfileRow
                                icon={deviceBound ? 'lock' : 'lock_open'}
                                tone={deviceBound ? 'success' : 'muted'}
                                label="Thiết bị tin cậy"
                                value={deviceBound
                                    ? `Đã ghép ngày ${user.trusted_device_bound_at ? formatDateString(user.trusted_device_bound_at) : '--'}`
                                    : 'Chưa ghép thiết bị'}
                                trailing={(
                                    <span className={`ui-pill ${deviceBound ? 'ui-pill-success' : 'ui-pill-warning'}`}>
                                        {deviceBound ? 'An toàn' : 'Chưa bật'}
                                    </span>
                                )}
                            />
                        </div>
                    </div>

                    {/* Account ------------------------------------------------- */}
                    <div>
                        <div className="ui-label-row">
                            <span className="ui-label">Tài khoản &amp; bảo mật</span>
                        </div>
                        <div className="ui-card ui-card-flush profile-card">
                            <ProfileRow
                                icon="key"
                                tone="warning"
                                label="Đổi mật khẩu"
                                value="Cập nhật mật khẩu bảo vệ tài khoản"
                                isAction
                                trailing={<span className="material-symbols-rounded" aria-hidden="true">chevron_right</span>}
                                onClick={() => setShowPwdModal(true)}
                            />
                            <ProfileRow
                                icon="logout"
                                tone="danger"
                                label="Đăng xuất tài khoản"
                                value="Kết thúc phiên làm việc trên thiết bị này"
                                isAction
                                isDestructive
                                trailing={<span className="material-symbols-rounded" aria-hidden="true">power_settings_new</span>}
                                onClick={() => {
                                    triggerHaptic('medium');
                                    setShowLogoutConfirm(true);
                                }}
                            />
                        </div>
                    </div>

                    <div className="ui-footer">
                        <span className="ui-footer-line">
                            <span className="material-symbols-rounded ui-tone-primary" aria-hidden="true">verified_user</span>
                            {APP_INFO.PRODUCT_NAME} v{APP_INFO.VERSION}
                        </span>
                        <span className="ui-footer-sub">Bản quyền thuộc về {APP_INFO.BRAND} · {APP_INFO.DOMAIN}</span>
                    </div>
                </div>
            </div>

            {showPwdModal && (
                <div className="confirm-backdrop animate-fade-in">
                    <section
                        ref={passwordDialogRef}
                        tabIndex={-1}
                        className="confirm-dialog animate-scale-in"
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="profile-password-dialog-title"
                        aria-describedby="profile-password-dialog-description"
                        aria-busy={loadingPwd}
                    >
                        <div className="confirm-content">
                            <div className="confirm-icon confirm-icon-warning">
                                <span className="material-symbols-rounded" aria-hidden="true">lock_reset</span>
                            </div>
                            <h3 id="profile-password-dialog-title">Đổi mật khẩu</h3>
                            <p id="profile-password-dialog-description" className="confirm-message">
                                Mật khẩu mới áp dụng cho lần đăng nhập tiếp theo trên mọi thiết bị.
                            </p>

                            <div className="confirm-form ui-form">
                                <div className="ui-field">
                                    <label className="ui-field-label ui-field-label-required" htmlFor="profile-current-password">Mật khẩu hiện tại</label>
                                    <input
                                        id="profile-current-password"
                                        type="password"
                                        autoComplete="current-password"
                                        className="ui-control"
                                        placeholder="••••••••"
                                        value={passData.old}
                                        onChange={e => setPassData({ ...passData, old: e.target.value })}
                                    />
                                </div>

                                <div className="ui-field">
                                    <label className="ui-field-label ui-field-label-required" htmlFor="profile-new-password">Mật khẩu mới</label>
                                    <input
                                        id="profile-new-password"
                                        type="password"
                                        autoComplete="new-password"
                                        aria-describedby="profile-new-password-hint"
                                        className="ui-control"
                                        placeholder="••••••••"
                                        value={passData.new}
                                        onChange={e => setPassData({ ...passData, new: e.target.value })}
                                    />
                                    <span id="profile-new-password-hint" className="ui-field-foot">
                                        <span>Ít nhất {TMS_LIMITS.ACCOUNT_PASSWORD_MIN_LENGTH} ký tự.</span>
                                    </span>
                                </div>

                                <div className="ui-field">
                                    <label className="ui-field-label ui-field-label-required" htmlFor="profile-confirm-password">Xác nhận mật khẩu</label>
                                    <input
                                        id="profile-confirm-password"
                                        type="password"
                                        autoComplete="new-password"
                                        className={`ui-control ${passData.confirm && passData.confirm !== passData.new ? 'ui-control-invalid' : ''}`.trim()}
                                        placeholder="••••••••"
                                        value={passData.confirm}
                                        onChange={e => setPassData({ ...passData, confirm: e.target.value })}
                                    />
                                    {passData.confirm && passData.confirm !== passData.new ? (
                                        <p className="ui-field-error">
                                            <span className="material-symbols-rounded" aria-hidden="true">error</span>
                                            Hai mật khẩu chưa khớp nhau.
                                        </p>
                                    ) : null}
                                </div>
                            </div>
                        </div>

                        <div className="confirm-actions">
                            <button type="button" onClick={() => setShowPwdModal(false)} disabled={loadingPwd} className="ui-button ui-button-quiet">
                                Hủy
                            </button>
                            <button type="button" onClick={handleUpdatePassword} disabled={loadingPwd} className="ui-cta">
                                {loadingPwd ? (
                                    <span className="material-symbols-rounded ui-spin" aria-hidden="true">progress_activity</span>
                                ) : (
                                    'Lưu thay đổi'
                                )}
                            </button>
                        </div>
                    </section>
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
