import React, { useRef, useMemo } from 'react';
import { Employee, LocationConfig } from '@/shared/types';
import Avatar from '@/shared/components/common/Avatar';
import ModalHeader from '@/shared/components/modals/ModalHeader';
import { useModalAccessibility } from '@/shared/components/modals/useModalAccessibility';
import { triggerHaptic } from '@/core/utils/helpers';
import BottomNav, { TabType } from './BottomNav';
import { TMS_LIMITS } from '@/shared/constants';

interface Props {
    contact: Employee | null;
    isOpen: boolean;
    onClose: () => void;
    locationsMap: Record<string, string>;
    empNameMap: Record<string, string>;
    locations: LocationConfig[];
    onNavigate: (tab: TabType) => void;
}

interface ContactDetailRowProps {
    icon: string;
    tone: 'primary' | 'info' | 'success' | 'warning';
    label: string;
    value: string;
    href?: string;
}

const ContactDetailRow: React.FC<ContactDetailRowProps> = ({ icon, tone, label, value, href }) => {
    const content = (
        <>
            <span className={`ui-row-icon ui-tone-${tone}`} aria-hidden="true">
                <span className="material-symbols-rounded">{icon}</span>
            </span>
            <span className="ui-row-body">
                <span className="ui-row-label">{label}</span>
                <span className="ui-row-value">{value || '—'}</span>
            </span>
            {href ? <span className="material-symbols-rounded ui-row-trail" aria-hidden="true">chevron_right</span> : null}
        </>
    );

    if (href) return <a href={href} className="ui-row">{content}</a>;
    return <div className="ui-row">{content}</div>;
};

const ModalContactDetail: React.FC<Props> = ({ contact, isOpen, onClose, locationsMap, empNameMap, locations, onNavigate }) => {
    const touchStart = useRef<{ x: number, y: number } | null>(null);
    const touchEnd = useRef<{ x: number, y: number } | null>(null);
    const activeTab: TabType = 'contacts';
    const dialogRef = useModalAccessibility(isOpen && !!contact, onClose);

    const contactAddress = useMemo(() => {
        if (!contact) return '';
        const loc = locations.find(l => l.center_id === contact.center_id);
        return loc?.address || '';
    }, [contact, locations]);

    const managedLocationNames = useMemo(() => {
        if (!contact || !contact.managed_locations || !Array.isArray(contact.managed_locations) || contact.managed_locations.length === 0) return '';
        return contact.managed_locations.map(id => locationsMap[id] || id).join(', ');
    }, [contact, locationsMap]);

    if (!contact || !isOpen) return null;

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

        if (Math.abs(distanceX) < Math.abs(distanceY)) return;

        if (distanceX > TMS_LIMITS.SWIPE_MODAL_CLOSE_PX) {
            e.stopPropagation();
            triggerHaptic('light');
            onClose();
        }
    };

    const shortId = contact.employee_id ? String(contact.employee_id) : '';

    return (
        <div
            ref={dialogRef}
            tabIndex={-1}
            className="app-modal-screen app-modal-screen-solid animate-slide-up transition-colors duration-300"
            role="dialog"
            aria-modal="true"
            aria-labelledby="contact-detail-title"
        >
            <div className="app-modal-header-layer app-contact-header-layer">
                <ModalHeader
                    title="Hồ sơ nhân sự"
                    subtitle={contact.department || undefined}
                    onClose={() => { triggerHaptic('light'); onClose(); }}
                />
            </div>

            <div
                className="app-modal-content no-scrollbar"
                onTouchStart={onTouchStart}
                onTouchMove={onTouchMove}
                onTouchEnd={onTouchEnd}
            >
                <div className="ui-stack ui-stack-lg animate-fade-in">
                    {/* Identity ------------------------------------------- */}
                    <section className="profile-hero">
                        <div className="profile-hero-cover">
                            <span className="profile-hero-chip">
                                <span className="material-symbols-rounded" aria-hidden="true">badge</span>
                                {contact.position || 'Nhân viên'}
                            </span>
                            {shortId ? <span className="profile-hero-chip profile-hero-chip-ghost">{shortId}</span> : null}
                        </div>

                        <div className="profile-hero-body">
                            <div className="profile-hero-avatar">
                                <Avatar
                                    src={contact.avatar_url || contact.face_ref_url}
                                    name={contact.name}
                                    className="w-full h-full rounded-full"
                                    textSize="text-3xl"
                                />
                            </div>
                            <h2 id="contact-detail-title" className="profile-hero-name">{contact.name}</h2>
                            <div className="profile-hero-tags">
                                {contact.department ? <span className="ui-pill ui-pill-primary">{contact.department}</span> : null}
                                {contact.position ? <span className="ui-pill ui-pill-info">{contact.position}</span> : null}
                            </div>
                        </div>
                    </section>

                    {/* Reach them ----------------------------------------- */}
                    <div className="ui-chips">
                        {contact.phone ? (
                            <a className="ui-chip" href={`tel:${contact.phone}`} onClick={() => triggerHaptic('light')}>
                                <span className="material-symbols-rounded" aria-hidden="true">call</span>
                                Gọi điện
                            </a>
                        ) : null}
                        {contact.email ? (
                            <a className="ui-chip" href={`mailto:${contact.email}`} onClick={() => triggerHaptic('light')}>
                                <span className="material-symbols-rounded" aria-hidden="true">mail</span>
                                Gửi email
                            </a>
                        ) : null}
                        {contact.phone ? (
                            <a className="ui-chip" href={`sms:${contact.phone}`} onClick={() => triggerHaptic('light')}>
                                <span className="material-symbols-rounded" aria-hidden="true">chat</span>
                                Nhắn tin
                            </a>
                        ) : null}
                    </div>

                    {/* Work ----------------------------------------------- */}
                    <div>
                        <div className="ui-label-row"><span className="ui-label">Thông tin công việc</span></div>
                        <section className="ui-card ui-card-flush">
                            {managedLocationNames ? (
                                <ContactDetailRow icon="account_tree" tone="primary" label="Trung tâm phụ trách" value={managedLocationNames} />
                            ) : null}
                            {contactAddress ? (
                                <ContactDetailRow icon="location_on" tone="info" label="Địa chỉ làm việc" value={contactAddress} />
                            ) : null}
                            {contact.direct_manager_id && empNameMap[contact.direct_manager_id] ? (
                                <ContactDetailRow
                                    icon="supervisor_account"
                                    tone="success"
                                    label="Quản lý trực tiếp"
                                    value={empNameMap[contact.direct_manager_id] || contact.direct_manager_id}
                                />
                            ) : null}
                            {!managedLocationNames && !contactAddress && !contact.direct_manager_id ? (
                                <ContactDetailRow icon="work" tone="primary" label="Phòng ban" value={contact.department || ''} />
                            ) : null}
                        </section>
                    </div>

                    {/* Contact -------------------------------------------- */}
                    <div>
                        <div className="ui-label-row"><span className="ui-label">Thông tin liên hệ</span></div>
                        <section className="ui-card ui-card-flush">
                            <ContactDetailRow
                                icon="alternate_email"
                                tone="primary"
                                label="Email công vụ"
                                value={contact.email || ''}
                                href={contact.email ? `mailto:${contact.email}` : undefined}
                            />
                            {contact.phone ? (
                                <ContactDetailRow
                                    icon="call"
                                    tone="success"
                                    label="Số điện thoại"
                                    value={String(contact.phone)}
                                    href={`tel:${contact.phone}`}
                                />
                            ) : null}
                        </section>
                    </div>
                </div>
            </div>

            <BottomNav
                activeTab={activeTab}
                onChange={(t) => {
                    triggerHaptic('light');
                    onNavigate(t);
                }}
            />
        </div>
    );
};

export default ModalContactDetail;
