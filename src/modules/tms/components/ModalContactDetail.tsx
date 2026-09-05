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
    tone: 'primary' | 'info' | 'success';
    label: string;
    value: string;
    href?: string;
}

const ContactDetailRow: React.FC<ContactDetailRowProps> = ({ icon, tone, label, value, href }) => {
    const content = <>
        <span className={`app-item-icon app-icon-tone-${tone}`}>
            <span className="material-symbols-rounded" aria-hidden="true">{icon}</span>
        </span>
        <span className="profile-row-content">
            <small>{label}</small>
            <strong>{value || label}</strong>
        </span>
    </>;

    if (href) return <a href={href} className="profile-row">{content}</a>;
    return <div className="profile-row">{content}</div>;
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
                    onClose={() => { triggerHaptic('light'); onClose(); }}
                    bgClass="bg-transparent border-none"
                />
            </div>

            <div
                className="app-modal-content no-scrollbar"
                onTouchStart={onTouchStart}
                onTouchMove={onTouchMove}
                onTouchEnd={onTouchEnd}
            >
                <div className="animate-fade-in mt-4">
                    <div className="app-surface profile-identity-card">
                        <div className="app-hero-tint" aria-hidden="true"></div>
                        <div className="absolute top-0 left-0 w-full h-32 overflow-hidden pointer-events-none opacity-10">
                            <div className="contact-decor-ring contact-decor-ring-small"></div>
                            <div className="contact-decor-ring contact-decor-ring-large"></div>
                        </div>

                        <div className="relative z-10 flex flex-col items-center">
                            <div className="w-32 h-32 rounded-full p-1.5 bg-neutral-white dark:bg-dark-surface mb-4 mt-2 relative overflow-hidden transition-colors">
                                <Avatar
                                    src={contact.avatar_url || contact.face_ref_url}
                                    name={contact.name}
                                    className="w-full h-full"
                                    textSize="text-4xl"
                                />
                            </div>
                            <h2 id="contact-detail-title" className="text-2xl font-black text-neutral-black dark:text-dark-text-primary  leading-tight">{contact.name}</h2>

                            <div className="mt-3 flex gap-2 flex-wrap justify-center">
                                <span className="px-3 py-1.5 bg-primary/10 dark:bg-primary/20 border border-primary/20 dark:border-primary/30 rounded-lg text-xxs font-extrabold text-primary dark:text-primary uppercase tracking-wide">{contact.department}</span>
                                <span className="px-3 py-1.5 bg-secondary-purple/10 dark:bg-secondary-purple/20 border border-secondary-purple/20 dark:border-secondary-purple/30 rounded-lg text-xxs font-extrabold text-secondary-purple dark:text-secondary-purple uppercase tracking-wide">{contact.position}</span>
                            </div>
                        </div>
                    </div>

                    <h3 className="app-section-title app-section-title-spaced">
                        <span className="material-symbols-rounded" aria-hidden="true">work</span> Thông tin công việc
                    </h3>
                    <div className="app-list-surface profile-section divide-y divide-slate-50 dark:divide-dark-border">
                        <ContactDetailRow
                            icon="account_tree"
                            tone="primary"
                            label="Trung tâm phụ trách"
                            value={managedLocationNames}
                        />
                        {contactAddress && (
                            <ContactDetailRow
                                icon="location_on"
                                tone="info"
                                label="Địa chỉ làm việc"
                                value={contactAddress}
                            />
                        )}
                        {contact.direct_manager_id && empNameMap[contact.direct_manager_id] && (
                            <ContactDetailRow
                                icon="person"
                                tone="success"
                                label="Quản lý trực tiếp"
                                value={empNameMap[contact.direct_manager_id] || contact.direct_manager_id}
                            />
                        )}
                    </div>

                    <h3 className="app-section-title app-section-title-spaced">
                        <span className="material-symbols-rounded" aria-hidden="true">contacts</span> Thông tin liên hệ
                    </h3>
                    <div className="app-list-surface profile-section divide-y divide-slate-50 dark:divide-dark-border">
                        <ContactDetailRow
                            icon="mail"
                            tone="primary"
                            label="Email"
                            value={contact.email || ''}
                            href={contact.email ? `mailto:${contact.email}` : undefined}
                        />
                        {contact.phone ? <ContactDetailRow
                            icon="call"
                            tone="success"
                            label="Số điện thoại"
                            value={String(contact.phone)}
                            href={`tel:${contact.phone}`}
                        /> : null}
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
