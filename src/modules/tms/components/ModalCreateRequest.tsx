import React, { useState, useEffect, useRef } from 'react';
import { Employee, DashboardData } from '@/shared/types';
import { submitRequest } from '@/modules/tms/services/employee';
import { formatDateShort, triggerHaptic } from '@/core/utils/helpers';
import ModalHeader from '@/shared/components/modals/ModalHeader';
import { useModalAccessibility } from '@/shared/components/modals/useModalAccessibility';
import { useListboxNavigation } from '@/shared/components/common/useListboxNavigation';
import BottomNav, { TabType } from './BottomNav';
import { LEAVE_REQUEST_TYPES } from '@/shared/constants';
import { useModalSwipeBack } from '@/shared/hooks/useModalSwipeBack';

interface Props {
    user: Employee;
    isOpen: boolean;
    /** Preselects the request type when opened from a quick-create shortcut. */
    initialType?: string;
    onClose: () => void;
    onSuccess: () => void;
    onAlert: (title: string, msg: string, type: 'success' | 'error' | 'warning') => void;
    onNavigate: (tab: TabType) => void;
    data: DashboardData | null;
}

interface RequestFormErrors {
    type?: string;
    fromDate?: string;
    toDate?: string;
    reason?: string;
}

/** Same tone mapping the Requests list uses, so a draft looks like its record. */
function typeConfig(type: string) {
    if (type.includes('Nghỉ ốm')) return { icon: 'medical_services', tone: 'danger' };
    if (type.includes('Nghỉ không lương')) return { icon: 'event_busy', tone: 'warning' };
    if (type.includes('Làm việc tại nhà')) return { icon: 'home_work', tone: 'success' };
    if (type.includes('Công tác')) return { icon: 'flight_takeoff', tone: 'info' };
    if (type.includes('Nghỉ phép')) return { icon: 'beach_access', tone: 'primary' };
    return { icon: 'description', tone: 'muted' };
}

/** Inclusive day span; a same-day request counts as one day. */
function dayCount(from: string, to: string) {
    if (!from || !to || from > to) return 0;
    const start = new Date(`${from}T00:00:00`);
    const end = new Date(`${to}T00:00:00`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0;
    return Math.max(1, Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1);
}

const REASON_MAX_LENGTH = 500;

const ModalCreateRequest: React.FC<Props> = ({ user, isOpen, initialType, onClose, onSuccess, onAlert, onNavigate, data }) => {
    const [formData, setFormData] = useState({
        type: 'Nghỉ phép',
        fromDate: '',
        toDate: '',
        reason: ''
    });
    const [loading, setLoading] = useState(false);
    const [isTypeOpen, setIsTypeOpen] = useState(false);
    const [formErrors, setFormErrors] = useState<RequestFormErrors>({});
    const activeTab: TabType = 'requests';

    const fromDateRef = useRef<HTMLInputElement>(null);
    const toDateRef = useRef<HTMLInputElement>(null);
    const reasonRef = useRef<HTMLTextAreaElement>(null);
    const dialogRef = useModalAccessibility(isOpen, onClose, { closeOnEscape: !loading });
    const swipeBackHandlers = useModalSwipeBack(onClose, loading);
    const navigateFromModal = (tab: TabType) => {
        triggerHaptic('light');
        onClose();
        onNavigate(tab);
    };
    const typeListbox = useListboxNavigation({
        isOpen: isTypeOpen,
        optionCount: LEAVE_REQUEST_TYPES.length,
        selectedIndex: LEAVE_REQUEST_TYPES.findIndex((type) => type === formData.type),
        onOpen: () => setIsTypeOpen(true),
        onClose: () => setIsTypeOpen(false),
    });

    useEffect(() => {
        if (isOpen) {
            const preset = initialType && LEAVE_REQUEST_TYPES.includes(initialType as typeof LEAVE_REQUEST_TYPES[number])
                ? initialType
                : 'Nghỉ phép';
            setFormData({ type: preset, fromDate: '', toDate: '', reason: '' });
            setFormErrors({});
            setIsTypeOpen(false);
        }
    }, [isOpen, initialType]);

    const focusFirstError = (errors: RequestFormErrors) => {
        const target = errors.type
            ? typeListbox.triggerRef.current
            : errors.fromDate
                ? fromDateRef.current
                : errors.toDate
                    ? toDateRef.current
                    : reasonRef.current;
        window.requestAnimationFrame(() => target?.focus());
    };

    const setFieldValue = (field: keyof typeof formData, value: string) => {
        setFormData((current) => ({ ...current, [field]: value }));
        setFormErrors((current) => ({ ...current, [field]: undefined }));
    };

    const handleSubmit = async () => {
        triggerHaptic('light');
        const requiredErrors: RequestFormErrors = {};
        if (!formData.fromDate) requiredErrors.fromDate = 'Vui lòng chọn ngày bắt đầu.';
        if (!formData.toDate) requiredErrors.toDate = 'Vui lòng chọn ngày kết thúc.';
        if (!formData.reason.trim()) requiredErrors.reason = 'Vui lòng nhập lý do chi tiết.';
        if (Object.keys(requiredErrors).length > 0) {
            setFormErrors(requiredErrors);
            focusFirstError(requiredErrors);
            onAlert("Thiếu thông tin", "Vui lòng nhập đầy đủ ngày và lý do.", 'warning');
            return;
        }

        if (formData.fromDate > formData.toDate) {
            const errors = { toDate: 'Ngày kết thúc phải sau hoặc bằng ngày bắt đầu.' };
            setFormErrors(errors);
            focusFirstError(errors);
            onAlert("Lỗi ngày tháng", "Ngày kết thúc phải sau hoặc bằng ngày bắt đầu.", 'error');
            return;
        }

        if (formData.type === 'Nghỉ phép') {
            if ((user.annual_leave_balance || 0) <= 0) {
                const errors = { type: 'Quỹ phép năm đã hết. Hãy chọn loại đề xuất khác.' };
                setFormErrors(errors);
                focusFirstError(errors);
                onAlert("Hết phép năm", "Bạn đã hết quỹ phép năm. Vui lòng chọn loại nghỉ khác, ví dụ nghỉ không lương.", 'error');
                return;
            }
        }

        if (data && data.myRequests) {
            const hasOverlap = data.myRequests.some(req => {
                if (req.status === 'Rejected') return false;
                return formData.fromDate <= req.to_date && formData.toDate >= req.from_date;
            });

            if (hasOverlap) {
                const errors = { toDate: 'Khoảng ngày này trùng với một đề xuất đã có.' };
                setFormErrors(errors);
                focusFirstError(errors);
                onAlert("Trùng lặp", "Bạn đã có đơn xin nghỉ/công tác trong khoảng thời gian này.", 'error');
                return;
            }
        }

        setFormErrors({});
        setLoading(true);
        const res = await submitRequest(formData);
        setLoading(false);

        onAlert(res.success ? "Thành công" : "Lỗi", res.message, res.success ? 'success' : 'error');

        if (res.success) {
            triggerHaptic('success');
            setFormData({ type: 'Nghỉ phép', fromDate: '', toDate: '', reason: '' });
            onSuccess();
            onClose();
        } else {
            triggerHaptic('error');
        }
    };

    const formatDateDisplay = (dateStr: string) => {
        return formatDateShort(dateStr);
    };

    const handleTypeSelect = (type: string) => {
        triggerHaptic('light');
        setFieldValue('type', type);
        setIsTypeOpen(false);
        window.requestAnimationFrame(() => typeListbox.triggerRef.current?.focus());
    };

    if (!isOpen) return null;

    const selectedType = typeConfig(formData.type);
    const span = dayCount(formData.fromDate, formData.toDate);
    const leaveBalance = user.annual_leave_balance ?? 0;
    const overspendsLeave = formData.type === 'Nghỉ phép' && span > leaveBalance;
    const firstError = formErrors.type || formErrors.fromDate || formErrors.toDate || formErrors.reason || '';

    return (
        <div
            ref={dialogRef}
            tabIndex={-1}
            className="app-modal-screen app-modal-screen-solid animate-slide-up transition-colors duration-300"
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-request-title"
            aria-busy={loading}
            data-swipe-surface="modal"
            {...swipeBackHandlers}
        >
            <div className="app-modal-header-layer">
                <ModalHeader
                    title="Tạo đề xuất"
                    subtitle={`${user.name} · ${user.employee_id}`}
                    onClose={() => { triggerHaptic('light'); onClose(); }}
                />
            </div>

            <div className="app-modal-content no-scrollbar">
                <div className="ui-stack animate-fade-in">
                    {/* What this sheet is for ----------------------------- */}
                    <section className="ui-sheet-hero">
                        <span className="ui-sheet-hero-icon" aria-hidden="true">
                            <span className="material-symbols-rounded">{selectedType.icon}</span>
                        </span>
                        <span className="ui-sheet-hero-body">
                            <span id="create-request-title" className="ui-sheet-hero-title">{formData.type}</span>
                            <span className="ui-sheet-hero-sub">Đơn được gửi tới quản lý trực tiếp và ghi vào bảng công của bạn.</span>
                        </span>
                    </section>

                    {/* The form ------------------------------------------- */}
                    <div>
                        <div className="ui-label-row">
                            <span className="ui-label">Thông tin đề xuất</span>
                            {span > 0 ? <span className="ui-pill ui-pill-primary">{span} ngày</span> : null}
                        </div>

                        <section className="ui-card ui-card-form ui-card-pad">
                            <p className="sr-only" role="alert" aria-live="assertive">{firstError}</p>

                            <div className="ui-form">
                                <div className="ui-field">
                                    <label className="ui-field-label ui-field-label-required" htmlFor="request-type-trigger">Loại đề xuất</label>
                                    <button
                                        ref={typeListbox.triggerRef}
                                        id="request-type-trigger"
                                        type="button"
                                        onClick={() => { triggerHaptic('light'); setIsTypeOpen((open) => !open); }}
                                        onKeyDown={typeListbox.handleTriggerKeyDown}
                                        className={`ui-control ${formErrors.type ? 'ui-control-invalid' : ''}`.trim()}
                                        aria-haspopup="listbox"
                                        aria-expanded={isTypeOpen}
                                        aria-controls="request-type-options"
                                        aria-invalid={!!formErrors.type}
                                        aria-describedby={formErrors.type ? 'request-type-error' : undefined}
                                        data-modal-escape-layer={isTypeOpen ? 'true' : undefined}
                                    >
                                        <span className={`ui-tile ui-tile-sm ui-tile-soft ui-tone-${selectedType.tone}`} aria-hidden="true">
                                            <span className="material-symbols-rounded">{selectedType.icon}</span>
                                        </span>
                                        <span className="ui-control-value">{formData.type}</span>
                                        <span className={`material-symbols-rounded ui-control-chevron ${isTypeOpen ? 'ui-control-chevron-open' : ''}`.trim()} aria-hidden="true">expand_more</span>
                                    </button>
                                    {formErrors.type ? (
                                        <p id="request-type-error" className="ui-field-error">
                                            <span className="material-symbols-rounded" aria-hidden="true">error</span>
                                            {formErrors.type}
                                        </p>
                                    ) : null}

                                    {isTypeOpen && (
                                        <div
                                            id="request-type-options"
                                            role="listbox"
                                            aria-label="Loại đề xuất"
                                            data-modal-escape-layer="true"
                                            className="ui-menu animate-fade-in"
                                        >
                                            {LEAVE_REQUEST_TYPES.map((type, index) => {
                                                const option = typeConfig(type);
                                                const isSelected = formData.type === type;
                                                return (
                                                    <button
                                                        ref={typeListbox.registerOption(index)}
                                                        type="button"
                                                        key={type}
                                                        role="option"
                                                        aria-selected={isSelected}
                                                        onClick={() => handleTypeSelect(type)}
                                                        onKeyDown={(event) => typeListbox.handleOptionKeyDown(event, index)}
                                                        className={`ui-menu-item ${isSelected ? 'ui-menu-item-active' : ''}`.trim()}
                                                    >
                                                        <span className={`ui-tile ui-tile-sm ui-tile-soft ui-tone-${option.tone}`} aria-hidden="true">
                                                            <span className="material-symbols-rounded">{option.icon}</span>
                                                        </span>
                                                        <span className="ui-menu-item-label">{type}</span>
                                                        {isSelected ? <span className="material-symbols-rounded" aria-hidden="true">check</span> : null}
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    )}
                                </div>

                                <div className="ui-form-grid">
                                    <div className="ui-field">
                                        <label className="ui-field-label ui-field-label-required" htmlFor="request-from-date">Từ ngày</label>
                                        <div className="ui-date">
                                            <input
                                                ref={fromDateRef}
                                                id="request-from-date"
                                                type="date"
                                                required
                                                value={formData.fromDate}
                                                onChange={e => setFieldValue('fromDate', e.target.value)}
                                                aria-invalid={!!formErrors.fromDate}
                                                aria-describedby={formErrors.fromDate ? 'request-from-date-error' : undefined}
                                            />
                                            <span className={`ui-control ${formErrors.fromDate ? 'ui-control-invalid' : ''}`.trim()} aria-hidden="true">
                                                <span className={`ui-control-value ${formData.fromDate ? '' : 'ui-control-placeholder'}`.trim()}>
                                                    {formData.fromDate ? formatDateDisplay(formData.fromDate) : 'dd/mm/yyyy'}
                                                </span>
                                                <span className="material-symbols-rounded ui-control-chevron">calendar_today</span>
                                            </span>
                                        </div>
                                        {formErrors.fromDate ? (
                                            <p id="request-from-date-error" className="ui-field-error">
                                                <span className="material-symbols-rounded" aria-hidden="true">error</span>
                                                {formErrors.fromDate}
                                            </p>
                                        ) : null}
                                    </div>

                                    <div className="ui-field">
                                        <label className="ui-field-label ui-field-label-required" htmlFor="request-to-date">Đến ngày</label>
                                        <div className="ui-date">
                                            <input
                                                ref={toDateRef}
                                                id="request-to-date"
                                                type="date"
                                                required
                                                min={formData.fromDate || undefined}
                                                value={formData.toDate}
                                                onChange={e => setFieldValue('toDate', e.target.value)}
                                                aria-invalid={!!formErrors.toDate}
                                                aria-describedby={formErrors.toDate ? 'request-to-date-error' : undefined}
                                            />
                                            <span className={`ui-control ${formErrors.toDate ? 'ui-control-invalid' : ''}`.trim()} aria-hidden="true">
                                                <span className={`ui-control-value ${formData.toDate ? '' : 'ui-control-placeholder'}`.trim()}>
                                                    {formData.toDate ? formatDateDisplay(formData.toDate) : 'dd/mm/yyyy'}
                                                </span>
                                                <span className="material-symbols-rounded ui-control-chevron">calendar_today</span>
                                            </span>
                                        </div>
                                        {formErrors.toDate ? (
                                            <p id="request-to-date-error" className="ui-field-error">
                                                <span className="material-symbols-rounded" aria-hidden="true">error</span>
                                                {formErrors.toDate}
                                            </p>
                                        ) : null}
                                    </div>
                                </div>

                                <div className="ui-field">
                                    <label className="ui-field-label ui-field-label-required" htmlFor="request-reason">Lý do chi tiết</label>
                                    <textarea
                                        ref={reasonRef}
                                        id="request-reason"
                                        required
                                        maxLength={REASON_MAX_LENGTH}
                                        className={`ui-control ${formErrors.reason ? 'ui-control-invalid' : ''}`.trim()}
                                        placeholder="Nêu rõ lý do để quản lý duyệt nhanh hơn…"
                                        value={formData.reason}
                                        onChange={e => setFieldValue('reason', e.target.value)}
                                        aria-invalid={!!formErrors.reason}
                                        aria-describedby={formErrors.reason ? 'request-reason-error' : undefined}
                                    />
                                    {formErrors.reason ? (
                                        <p id="request-reason-error" className="ui-field-error">
                                            <span className="material-symbols-rounded" aria-hidden="true">error</span>
                                            {formErrors.reason}
                                        </p>
                                    ) : (
                                        <span className="ui-field-foot">
                                            <span>Quản lý trực tiếp sẽ thấy nội dung này.</span>
                                            <span>{formData.reason.length}/{REASON_MAX_LENGTH}</span>
                                        </span>
                                    )}
                                </div>
                            </div>
                        </section>
                    </div>

                    {/* Leave budget --------------------------------------- */}
                    {formData.type === 'Nghỉ phép' ? (
                        <p className={`ui-note ${overspendsLeave ? 'ui-note-warning' : ''}`.trim()}>
                            <span className="material-symbols-rounded" aria-hidden="true">{overspendsLeave ? 'running_with_errors' : 'savings'}</span>
                            <span>
                                Quỹ phép năm còn <strong>{leaveBalance} ngày</strong>
                                {span > 0 ? <> · đơn này dùng <strong>{span} ngày</strong></> : null}
                                {overspendsLeave ? '. Đơn vượt quỹ có thể bị từ chối.' : '.'}
                            </span>
                        </p>
                    ) : null}

                    {/* Submit --------------------------------------------- */}
                    <button type="button" onClick={handleSubmit} disabled={loading} className="ui-cta">
                        {loading ? (
                            <span className="material-symbols-rounded ui-spin" aria-hidden="true">progress_activity</span>
                        ) : (
                            <>
                                <span className="material-symbols-rounded" aria-hidden="true">send</span>
                                Gửi đề xuất
                            </>
                        )}
                    </button>
                </div>
            </div>

            <BottomNav
                activeTab={activeTab}
                onChange={navigateFromModal}
            />
        </div>
    );
};

export default ModalCreateRequest;
