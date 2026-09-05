import React, { useState, useEffect, useRef, useMemo } from 'react';
import { DashboardData } from '@/shared/types';
import { submitExplanation } from '@/modules/tms/services/employee';
import { formatDateString, triggerHaptic, toISODateString } from '@/core/utils/helpers';
import ModalHeader from '@/shared/components/modals/ModalHeader';
import ConfirmDialog from '@/shared/components/modals/ConfirmDialog';
import { useModalAccessibility } from '@/shared/components/modals/useModalAccessibility';
import { useListboxNavigation } from '@/shared/components/common/useListboxNavigation';
import BottomNav, { TabType } from './BottomNav';
import { TMS_LIMITS } from '@/shared/constants';

interface Props {
    isOpen: boolean;
    onClose: () => void;
    onSuccess: () => void;
    onAlert: (title: string, msg: string, type: 'success' | 'error' | 'warning') => void;
    initialData?: { date: string, reason: string };
    explainableItems: { date: string, explainReason: string }[];
    onNavigate: (tab: TabType) => void;
    data: DashboardData | null;
}

interface ExplanationFormErrors {
    date?: string;
    reason?: string;
}

const ReasonBadge = ({ reason }: { reason: string }) => {
    let variantClass = 'badge-secondary';
    if (reason.includes('Vắng') || reason.includes('Quên') || reason.includes('vi phạm')) {
        variantClass = 'badge-error';
    } else if (reason.includes('Trễ')) {
        variantClass = 'badge-warning';
    } else if (reason.includes('sớm') || reason.includes('lễ') || reason.includes('phép')) {
        variantClass = 'badge-info';
    }

    return (
        <span className={`badge ${variantClass}`}>
            {reason}
        </span>
    );
};

const ReasonDisplay = ({ reasons }: { reasons: string }) => {
    const reasonList = reasons.split(', ').map(r => r.trim());
    return (
        <div className="flex items-center gap-2 flex-wrap">
            {reasonList.map((reason, index) => (
                <ReasonBadge key={index} reason={reason} />
            ))}
        </div>
    );
};

const ModalExplainWork: React.FC<Props> = ({ isOpen, onClose, onSuccess, onAlert, initialData, explainableItems, onNavigate, data }) => {
    const [selectedDate, setSelectedDate] = useState(initialData?.date || '');
    const [reason, setReason] = useState(initialData?.reason || '');
    const [confirmDialog, setConfirmDialog] = useState<{ isOpen: boolean, isPastMonth: boolean }>({ isOpen: false, isPastMonth: false });
    const [loading, setLoading] = useState(false);
    const [isDropdownOpen, setIsDropdownOpen] = useState(false);
    const [formErrors, setFormErrors] = useState<ExplanationFormErrors>({});
    const activeTab: TabType = 'history';

    const touchStart = useRef<{ x: number, y: number } | null>(null);
    const touchEnd = useRef<{ x: number, y: number } | null>(null);
    const reasonRef = useRef<HTMLTextAreaElement>(null);
    const dialogRef = useModalAccessibility(isOpen, onClose, { closeOnEscape: !loading });
    const dateListbox = useListboxNavigation({
        isOpen: isDropdownOpen,
        optionCount: explainableItems.length,
        selectedIndex: explainableItems.findIndex((item) => item.date === selectedDate),
        onOpen: () => setIsDropdownOpen(true),
        onClose: () => setIsDropdownOpen(false),
    });

    const lockDate = data?.systemConfig?.LOCK_DATE ?? TMS_LIMITS.LOCK_DATE;
    const maxPerMonth = data?.systemConfig?.MAX_EXPLANATIONS_PER_MONTH ?? TMS_LIMITS.MAX_EXPLANATIONS_PER_MONTH;

    const { monthExplanationsCount, isPastMonthSelected } = useMemo(() => {
        if (!selectedDate) return { monthExplanationsCount: 0, isPastMonthSelected: false };
        const targetMonthStr = selectedDate.slice(0, 7);
        const count = (data?.myExplanations || []).filter(exp => exp.date.startsWith(targetMonthStr)).length;
        const now = new Date();
        const curMonthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        return {
            monthExplanationsCount: count,
            isPastMonthSelected: targetMonthStr < curMonthStr,
        };
    }, [selectedDate, data?.myExplanations]);

    useEffect(() => {
        if (isOpen) {
            setSelectedDate(initialData?.date || '');
            setReason(initialData?.reason || '');
            setFormErrors({});
            setIsDropdownOpen(false);
        }
    }, [isOpen, initialData]);

    const handlePreSubmit = () => {
        triggerHaptic('light');
        const requiredErrors: ExplanationFormErrors = {};
        if (!selectedDate) requiredErrors.date = 'Vui lòng chọn ngày cần giải trình.';
        if (!reason.trim()) requiredErrors.reason = 'Vui lòng nhập lý do giải trình.';
        if (Object.keys(requiredErrors).length > 0) {
            setFormErrors(requiredErrors);
            window.requestAnimationFrame(() => {
                if (requiredErrors.date) dateListbox.triggerRef.current?.focus();
                else reasonRef.current?.focus();
            });
            onAlert("Thiếu thông tin", "Vui lòng chọn ngày và nhập lý do giải trình.", 'error');
            return;
        }

        const today = new Date();
        const todayStr = toISODateString(today);
        if (selectedDate > todayStr) {
            setFormErrors({ date: 'Không thể giải trình cho ngày trong tương lai.' });
            window.requestAnimationFrame(() => dateListbox.triggerRef.current?.focus());
            onAlert("Ngày không hợp lệ", "Không thể giải trình cho ngày trong tương lai.", 'error');
            return;
        }

        const curY = today.getFullYear();
        const curM = today.getMonth();
        const targetDate = new Date(selectedDate + 'T00:00:00');
        const startOfCurrentMonth = new Date(curY, curM, 1);
        const startOfPreviousMonth = new Date(curY, curM - 1, 1);
        const isPast = targetDate < startOfCurrentMonth;

        if (isPast) {
            if (targetDate < startOfPreviousMonth) {
                setFormErrors({ date: 'Không thể giải trình cho các tháng trước nữa.' });
                window.requestAnimationFrame(() => dateListbox.triggerRef.current?.focus());
                onAlert("Quá hạn", "Chỉ được phép giải trình cho tháng hiện tại hoặc tháng trước liền kề.", 'error');
                return;
            }
            if (today.getDate() > lockDate) {
                setFormErrors({ date: `Đã quá hạn chốt công tháng trước (Hạn chót ngày ${lockDate} hàng tháng).` });
                window.requestAnimationFrame(() => dateListbox.triggerRef.current?.focus());
                onAlert("Đã chốt công", `Đã quá hạn giải trình công tháng trước (Hạn chót ngày ${lockDate} hàng tháng).`, 'error');
                return;
            }
        }

        const targetMonthStr = selectedDate.slice(0, 7);
        const monthExplanations = (data?.myExplanations || []).filter(exp => exp.date.startsWith(targetMonthStr));
        if (monthExplanations.length >= maxPerMonth) {
            setFormErrors({ date: `Bạn đã đạt giới hạn ${maxPerMonth} lần giải trình trong tháng ${selectedDate.slice(5, 7)}/${selectedDate.slice(0, 4)}.` });
            window.requestAnimationFrame(() => dateListbox.triggerRef.current?.focus());
            onAlert("Vượt giới hạn", `Mỗi nhân viên chỉ được gửi tối đa ${maxPerMonth} đơn giải trình mỗi tháng.`, 'error');
            return;
        }

        if (data && data.myExplanations) {
            const hasOverlap = data.myExplanations.some(exp => {
                if (exp.status === 'Rejected') return false;
                return exp.date === selectedDate;
            });

            if (hasOverlap) {
                setFormErrors({ date: 'Bạn đã có một giải trình cho ngày này đang chờ duyệt hoặc đã duyệt.' });
                window.requestAnimationFrame(() => dateListbox.triggerRef.current?.focus());
                onAlert("Trùng lặp", "Đã có đơn giải trình cho ngày này đang chờ duyệt hoặc đã được duyệt.", 'error');
                return;
            }
        }

        setFormErrors({});
        setConfirmDialog({
            isOpen: true,
            isPastMonth: isPast
        });
    };

    const handleSubmitExplanation = async () => {
        setLoading(true);
        const res = await submitExplanation({ date: selectedDate, reason });

        if (res.success) {
            triggerHaptic('success');
            onAlert("Thành công", "Đã gửi giải trình.", 'success');
            onSuccess();
            onClose();
        } else {
            triggerHaptic('error');
            onAlert("Lỗi", res.message, 'error');
        }

        setLoading(false);
        setConfirmDialog({ isOpen: false, isPastMonth: false });
    };

    const handleDateSelect = (date: string, suggestedReason: string) => {
        triggerHaptic('light');
        setSelectedDate(date);
        setReason(suggestedReason);
        setFormErrors({});
        setIsDropdownOpen(false);
        window.requestAnimationFrame(() => dateListbox.triggerRef.current?.focus());
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

    const selectedItem = selectedDate ? explainableItems.find(i => i.date === selectedDate) : null;

    return (
        <>
            <div
                ref={dialogRef}
                tabIndex={-1}
                className="app-modal-screen animate-slide-up transition-colors duration-300"
                role="dialog"
                aria-modal="true"
                aria-labelledby="explain-work-title"
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
                            <div className="app-hero-tint app-hero-tint-warning" aria-hidden="true"></div>

                            <div className="relative z-10 flex flex-col items-center">
                                <div className="w-28 h-28 rounded-full p-1.5 bg-white dark:bg-dark-surface mb-4 mt-2 relative transition-colors">
                                    <div className="w-full h-full rounded-full bg-secondary-orange/10 dark:bg-secondary-orange/20 flex items-center justify-center border border-secondary-orange/20 dark:border-secondary-orange/30 text-secondary-orange dark:text-secondary-orange">
                                        <span className="material-symbols-rounded text-5xl ml-1">edit_document</span>
                                    </div>
                                </div>
                                <h2 id="explain-work-title" className="text-2xl font-black text-slate-900 dark:text-dark-text-primary leading-tight">Giải Trình Công</h2>
                                <p className="text-xs text-slate-500 dark:text-dark-text-secondary font-bold mt-2 uppercase tracking-wide">Bổ sung thông tin chấm công</p>
                            </div>
                        </div>

                        <h3 className="app-section-title app-section-title-spaced">
                            <span className="material-symbols-rounded" aria-hidden="true">fact_check</span>
                            Thông tin chi tiết
                        </h3>

                        <div className="app-surface app-form-card space-y-6">
                            <p className="sr-only" role="alert" aria-live="assertive">
                                {formErrors.date || formErrors.reason || ''}
                            </p>

                            <div className="relative">
                                <label className="input-label" htmlFor="explain-date-trigger">Chọn ngày cần giải trình</label>
                                <button
                                    ref={dateListbox.triggerRef}
                                    id="explain-date-trigger"
                                    type="button"
                                    onClick={() => { triggerHaptic('light'); setIsDropdownOpen((open) => !open); }}
                                    onKeyDown={dateListbox.handleTriggerKeyDown}
                                    className={`button-select justify-between w-full cursor-pointer ${formErrors.date ? 'border-secondary-red' : ''}`}
                                    aria-haspopup="listbox"
                                    aria-expanded={isDropdownOpen}
                                    aria-controls="explain-date-options"
                                    aria-invalid={!!formErrors.date}
                                    aria-describedby={formErrors.date ? 'explain-date-error' : undefined}
                                    data-modal-escape-layer={isDropdownOpen ? 'true' : undefined}
                                >
                                    <div className="text-left flex-1 flex items-center gap-3">
                                        {selectedItem ? (
                                            <>
                                                <ReasonDisplay reasons={selectedItem.explainReason} />
                                                <span className="app-detail-text block text-slate-900 dark:text-dark-text-primary font-bold ml-auto">
                                                    {formatDateString(selectedDate)}
                                                </span>
                                            </>
                                        ) : (
                                            <span className="app-detail-text text-slate-400 dark:text-dark-text-secondary">Chọn ngày...</span>
                                        )}
                                    </div>
                                    <span className={`material-symbols-rounded text-slate-400 dark:text-dark-text-secondary text-xl transition-transform duration-200 ml-3 ${isDropdownOpen ? 'rotate-180' : ''}`} aria-hidden="true">expand_more</span>
                                </button>
                                {formErrors.date ? <p id="explain-date-error" className="mt-1.5 text-xs font-semibold text-secondary-red">{formErrors.date}</p> : null}

                                {selectedDate && (
                                    <div className="mt-2 flex items-center justify-between text-xxs font-semibold">
                                        <span className={monthExplanationsCount >= maxPerMonth ? 'text-secondary-red font-bold' : monthExplanationsCount >= maxPerMonth - 1 ? 'text-secondary-yellow font-bold' : 'text-slate-400 dark:text-dark-text-secondary'}>
                                            Hạn mức tháng {selectedDate.slice(5, 7)}: {monthExplanationsCount}/{maxPerMonth} đơn
                                        </span>
                                        {isPastMonthSelected && (
                                            <span className="text-secondary-yellow dark:text-secondary-yellow font-bold">
                                                (Tháng trước · Hạn chót ngày {lockDate})
                                            </span>
                                        )}
                                    </div>
                                )}

                                {isDropdownOpen && (
                                    <div id="explain-date-options" role="listbox" aria-label="Ngày cần giải trình" data-modal-escape-layer="true" className="gemini-dropdown-menu app-dropdown-offset absolute left-0 w-full animate-fade-in p-2 space-y-1 max-h-64 overflow-y-auto custom-scrollbar">
                                        {explainableItems.length === 0 ? (
                                            <div className="p-4 text-center text-xs text-slate-400 dark:text-dark-text-secondary font-bold uppercase tracking-widest">Không có ngày nào cần giải trình</div>
                                        ) : (
                                            explainableItems.map((item, index) => (
                                                <button
                                                    ref={dateListbox.registerOption(index)}
                                                    type="button"
                                                    key={item.date}
                                                    role="option"
                                                    aria-selected={selectedDate === item.date}
                                                    onClick={() => handleDateSelect(item.date, item.explainReason || '')}
                                                    onKeyDown={(event) => dateListbox.handleOptionKeyDown(event, index)}
                                                    className={`gemini-dropdown-item ${selectedDate === item.date ? 'gemini-dropdown-item-active' : ''}`}
                                                >
                                                    <div className="flex-1 flex items-center gap-3">
                                                        <ReasonDisplay reasons={item.explainReason} />
                                                        <span className={`app-detail-text ml-auto ${selectedDate === item.date ? 'font-bold text-primary dark:text-primary' : 'font-medium text-slate-800 dark:text-dark-text-primary'}`}>
                                                            {formatDateString(item.date)}
                                                        </span>
                                                    </div>
                                                    {selectedDate === item.date && (
                                                        <span className="material-symbols-rounded text-primary dark:text-primary ml-3 text-lg" aria-hidden="true">check</span>
                                                    )}
                                                </button>
                                            ))
                                        )}
                                    </div>
                                )}
                            </div>

                            <div>
                                <label className="input-label" htmlFor="explain-reason-textarea">Lý do giải trình</label>
                                <textarea
                                    ref={reasonRef}
                                    id="explain-reason-textarea"
                                    required
                                    className="textarea-field h-32 resize-none"
                                    placeholder="Nhập lý do chi tiết..."
                                    value={reason}
                                    onChange={e => {
                                        setReason(e.target.value);
                                        setFormErrors((current) => ({ ...current, reason: undefined }));
                                    }}
                                    aria-invalid={!!formErrors.reason}
                                    aria-describedby={formErrors.reason ? 'explain-reason-error' : undefined}
                                ></textarea>
                                {formErrors.reason ? <p id="explain-reason-error" className="mt-1.5 text-xs font-semibold text-secondary-red">{formErrors.reason}</p> : null}
                            </div>

                            <button
                                type="button"
                                onClick={handlePreSubmit}
                                disabled={loading}
                                className="app-submit-button"
                            >
                                {loading ? <span className="material-symbols-rounded animate-spin">progress_activity</span> : <>Gửi giải trình <span className="material-symbols-rounded text-base">send</span></>}
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

            <ConfirmDialog
                isOpen={confirmDialog.isOpen}
                title="Gửi giải trình?"
                message={confirmDialog.isPastMonth ?
                    <span className="text-secondary-red font-bold flex items-center gap-1"><span className="material-symbols-rounded text-base">warning</span> Bạn đang giải trình cho tháng trước. Đơn này có thể bị tính là trễ hạn.</span>
                    :
                    <span>Hệ thống sẽ ghi nhận giải trình của bạn cho ngày <span className="text-neutral-black dark:text-dark-text-primary font-bold"> {formatDateString(selectedDate)}</span>.</span>
                }
                confirmLabel="Xác nhận gửi"
                onConfirm={handleSubmitExplanation}
                onCancel={() => setConfirmDialog({ ...confirmDialog, isOpen: false })}
                isLoading={loading}
                type={confirmDialog.isPastMonth ? 'warning' : 'success'}
            />
        </>
    );
};

export default ModalExplainWork;
