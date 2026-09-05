import React, { useState, useEffect, useRef } from 'react';
import { Employee, DashboardData } from '@/shared/types';
import { submitRequest } from '@/modules/tms/services/employee';
import { formatDateShort, triggerHaptic } from '@/core/utils/helpers';
import ModalHeader from '@/shared/components/modals/ModalHeader';
import { useModalAccessibility } from '@/shared/components/modals/useModalAccessibility';
import { useListboxNavigation } from '@/shared/components/common/useListboxNavigation';
import BottomNav, { TabType } from './BottomNav';
import { LEAVE_REQUEST_TYPES, TMS_LIMITS } from '@/shared/constants';

interface Props {
    user: Employee;
    isOpen: boolean;
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

const ModalCreateRequest: React.FC<Props> = ({ user, isOpen, onClose, onSuccess, onAlert, onNavigate, data }) => {
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

    const touchStart = useRef<{ x: number, y: number } | null>(null);
    const touchEnd = useRef<{ x: number, y: number } | null>(null);
    const fromDateRef = useRef<HTMLInputElement>(null);
    const toDateRef = useRef<HTMLInputElement>(null);
    const reasonRef = useRef<HTMLTextAreaElement>(null);
    const dialogRef = useModalAccessibility(isOpen, onClose, { closeOnEscape: !loading });
    const typeListbox = useListboxNavigation({
        isOpen: isTypeOpen,
        optionCount: LEAVE_REQUEST_TYPES.length,
        selectedIndex: LEAVE_REQUEST_TYPES.findIndex((type) => type === formData.type),
        onOpen: () => setIsTypeOpen(true),
        onClose: () => setIsTypeOpen(false),
    });

    useEffect(() => {
        if (isOpen) {
            setFormData({ type: 'Nghỉ phép', fromDate: '', toDate: '', reason: '' });
            setFormErrors({});
            setIsTypeOpen(false);
        }
    }, [isOpen]);

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

    if (!isOpen) return null;

    return (
        <div
            ref={dialogRef}
            tabIndex={-1}
            className="app-modal-screen animate-slide-up transition-colors duration-300"
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-request-title"
            aria-busy={loading}
        >
            <div className="app-modal-header-layer">
                <ModalHeader
                    onClose={() => { triggerHaptic('light'); onClose(); }}
                    bgClass="bg-transparent border-none"
                />
            </div>

            <div className="app-modal-content no-scrollbar"
                onTouchStart={onTouchStart}
                onTouchMove={onTouchMove}
                onTouchEnd={onTouchEnd}>
                <div className="animate-fade-in mt-4">

                    <div className="app-surface app-form-hero">
                        <div className="app-hero-tint" aria-hidden="true"></div>

                        <div className="relative z-10 flex flex-col items-center">
                            <div className="w-28 h-28 rounded-full p-1.5 bg-white dark:bg-dark-surface mb-4 mt-2 relative transition-colors">
                                <div className="w-full h-full rounded-full bg-primary/10 dark:bg-primary/20 flex items-center justify-center border border-primary/20 dark:border-primary/30 text-primary dark:text-primary">
                                    <span className="request-send-icon material-symbols-rounded text-5xl">send</span>
                                </div>
                            </div>
                            <h2 id="create-request-title" className="text-2xl font-black text-slate-900 dark:text-dark-text-primary leading-tight">Tạo Đề Xuất</h2>
                            <p className="text-xs text-slate-500 dark:text-dark-text-secondary font-bold mt-2 uppercase tracking-wide">Điền thông tin chi tiết bên dưới</p>
                        </div>
                    </div>

                    <h3 className="app-section-title app-section-title-spaced">
                        <span className="material-symbols-rounded" aria-hidden="true">edit_square</span>
                        Thông tin đề xuất
                    </h3>

                    <div className="app-surface app-form-card space-y-6">
                        <p className="sr-only" role="alert" aria-live="assertive">
                            {formErrors.type || formErrors.fromDate || formErrors.toDate || formErrors.reason || ''}
                        </p>

                        <div className="relative">
                            <label className="input-label" htmlFor="request-type-trigger">Loại đề xuất</label>
                            <button
                                ref={typeListbox.triggerRef}
                                id="request-type-trigger"
                                type="button"
                                onClick={() => { triggerHaptic('light'); setIsTypeOpen((open) => !open); }}
                                onKeyDown={typeListbox.handleTriggerKeyDown}
                                className={`button-select justify-between w-full cursor-pointer ${formErrors.type ? 'border-secondary-red' : ''}`}
                                aria-haspopup="listbox"
                                aria-expanded={isTypeOpen}
                                aria-controls="request-type-options"
                                aria-invalid={!!formErrors.type}
                                aria-describedby={formErrors.type ? 'request-type-error' : undefined}
                                data-modal-escape-layer={isTypeOpen ? 'true' : undefined}
                            >
                                <span className="app-detail-text text-slate-800 dark:text-dark-text-primary font-semibold">{formData.type}</span>
                                <span className={`material-symbols-rounded text-slate-400 dark:text-dark-text-secondary text-xl transition-transform duration-200 ${isTypeOpen ? 'rotate-180' : ''}`} aria-hidden="true">expand_more</span>
                            </button>
                            {formErrors.type ? <p id="request-type-error" className="mt-1.5 text-xs font-semibold text-secondary-red">{formErrors.type}</p> : null}

                            {isTypeOpen && (
                                <div id="request-type-options" role="listbox" aria-label="Loại đề xuất" data-modal-escape-layer="true" className="gemini-dropdown-menu app-dropdown-offset absolute left-0 w-full animate-fade-in p-2 space-y-1">
                                    {LEAVE_REQUEST_TYPES.map((type, index) => (
                                        <button
                                            ref={typeListbox.registerOption(index)}
                                            type="button"
                                            key={type}
                                            role="option"
                                            aria-selected={formData.type === type}
                                            onClick={() => handleTypeSelect(type)}
                                            onKeyDown={(event) => typeListbox.handleOptionKeyDown(event, index)}
                                            className={`gemini-dropdown-item ${formData.type === type ? 'gemini-dropdown-item-active' : ''}`}
                                        >
                                            <span className={`app-detail-text ${formData.type === type ? 'font-bold' : 'font-medium'}`}>{type}</span>
                                            {formData.type === type && (
                                                <span className="material-symbols-rounded text-primary dark:text-primary text-lg" aria-hidden="true">check</span>
                                            )}
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>

                        <div className="grid grid-cols-2 gap-4">
                            <div>
                                <label className="input-label" htmlFor="request-from-date">Từ ngày</label>
                                <div className="date-input-control relative h-13 w-full">
                                    <input
                                        ref={fromDateRef}
                                        id="request-from-date"
                                        type="date"
                                        required
                                        className="date-input-native absolute inset-0 z-20 opacity-0 cursor-pointer w-full h-full"
                                        value={formData.fromDate}
                                        onChange={e => setFieldValue('fromDate', e.target.value)}
                                        aria-invalid={!!formErrors.fromDate}
                                        aria-describedby={formErrors.fromDate ? 'request-from-date-error' : undefined}
                                    />
                                    <div className={`input-field flex items-center justify-between pointer-events-none z-10 w-full h-full ${formData.fromDate ? 'text-slate-900 dark:text-dark-text-primary font-semibold' : 'text-slate-400 dark:text-dark-text-secondary/60'}`}>
                                        <span>{formData.fromDate ? formatDateDisplay(formData.fromDate) : 'dd/mm/yyyy'}</span>
                                        <span className="material-symbols-rounded text-slate-400 dark:text-dark-text-secondary/60 text-lg" aria-hidden="true">calendar_today</span>
                                    </div>
                                </div>
                                {formErrors.fromDate ? <p id="request-from-date-error" className="mt-1.5 text-xs font-semibold text-secondary-red">{formErrors.fromDate}</p> : null}
                            </div>
                            <div>
                                <label className="input-label" htmlFor="request-to-date">Đến ngày</label>
                                <div className="date-input-control relative h-13 w-full">
                                    <input
                                        ref={toDateRef}
                                        id="request-to-date"
                                        type="date"
                                        required
                                        min={formData.fromDate || undefined}
                                        className="date-input-native absolute inset-0 z-20 opacity-0 cursor-pointer w-full h-full"
                                        value={formData.toDate}
                                        onChange={e => setFieldValue('toDate', e.target.value)}
                                        aria-invalid={!!formErrors.toDate}
                                        aria-describedby={formErrors.toDate ? 'request-to-date-error' : undefined}
                                    />
                                    <div className={`input-field flex items-center justify-between pointer-events-none z-10 w-full h-full ${formData.toDate ? 'text-slate-900 dark:text-dark-text-primary font-semibold' : 'text-slate-400 dark:text-dark-text-secondary/60'}`}>
                                        <span>{formData.toDate ? formatDateDisplay(formData.toDate) : 'dd/mm/yyyy'}</span>
                                        <span className="material-symbols-rounded text-slate-400 dark:text-dark-text-secondary/60 text-lg" aria-hidden="true">calendar_today</span>
                                    </div>
                                </div>
                                {formErrors.toDate ? <p id="request-to-date-error" className="mt-1.5 text-xs font-semibold text-secondary-red">{formErrors.toDate}</p> : null}
                            </div>
                        </div>

                        <div>
                            <label className="input-label" htmlFor="request-reason">Lý do chi tiết</label>
                            <textarea
                                ref={reasonRef}
                                id="request-reason"
                                required
                                className="textarea-field h-32 resize-none"
                                placeholder="Nhập lý do nghỉ hoặc giải trình..."
                                value={formData.reason}
                                onChange={e => setFieldValue('reason', e.target.value)}
                                aria-invalid={!!formErrors.reason}
                                aria-describedby={formErrors.reason ? 'request-reason-error' : undefined}
                            ></textarea>
                            {formErrors.reason ? <p id="request-reason-error" className="mt-1.5 text-xs font-semibold text-secondary-red">{formErrors.reason}</p> : null}
                        </div>

                        <button
                            type="button"
                            onClick={handleSubmit}
                            disabled={loading}
                            className="app-submit-button"
                        >
                            {loading ? <span className="material-symbols-rounded animate-spin">progress_activity</span> : <>Gửi đề xuất <span className="material-symbols-rounded text-base">send</span></>}
                        </button>
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

export default ModalCreateRequest;
