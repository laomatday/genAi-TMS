import React, { useState, useEffect, useRef, useMemo } from 'react';
import type { DashboardData, ExplainableAttendanceItem } from '@/shared/types';
import { requestCommandId, submitExplanation } from '@/modules/tms/services/employee';
import { formatDateString, triggerHaptic, toISODateString } from '@/core/utils/helpers';
import ModalHeader from '@/shared/components/modals/ModalHeader';
import ConfirmDialog from '@/shared/components/modals/ConfirmDialog';
import { useModalAccessibility } from '@/shared/components/modals/useModalAccessibility';
import { useListboxNavigation } from '@/shared/components/common/useListboxNavigation';
import BottomNav, { TabType } from './BottomNav';
import { TMS_LIMITS } from '@/shared/constants';
import { useModalSwipeBack } from '@/shared/hooks/useModalSwipeBack';

interface Props {
    isOpen: boolean;
    onClose: () => void;
    onSuccess: () => void;
    onAlert: (title: string, msg: string, type: 'success' | 'error' | 'warning') => void;
    initialData?: { date: string, reason: string };
    explainableItems: ExplainableAttendanceItem[];
    sourceTab?: 'history' | 'requests';
    onNavigate: (tab: TabType) => void;
    data: DashboardData | null;
}

interface ExplanationFormErrors {
    date?: string;
    reason?: string;
    checkin?: string;
    checkout?: string;
}

type ExplanationMode = 'EXPLANATION' | 'CORRECTION';

/** An attendance flag carries its severity in its wording; the pill tone follows. */
function flagTone(reason: string) {
    if (reason.includes('Vắng') || reason.includes('Quên') || reason.includes('Thiếu') || reason.includes('Không có') || reason.includes('vi phạm')) return 'danger';
    if (reason.includes('Trễ')) return 'warning';
    if (reason.includes('sớm') || reason.includes('lễ') || reason.includes('phép')) return 'info';
    return 'muted';
}

const ReasonDisplay = ({ reasons }: { reasons: string }) => (
    <>
        {reasons.split(', ').map((reason, index) => {
            const label = reason.trim();
            return <span key={`${label}-${index}`} className={`ui-pill ui-pill-${flagTone(label)}`}>{label}</span>;
        })}
    </>
);

const ModalExplainWork: React.FC<Props> = ({ isOpen, onClose, onSuccess, onAlert, initialData, explainableItems, sourceTab = 'history', onNavigate, data }) => {
    const [selectedDate, setSelectedDate] = useState(initialData?.date || '');
    const [reason, setReason] = useState(initialData?.reason || '');
    const [confirmDialog, setConfirmDialog] = useState<{ isOpen: boolean, isPastMonth: boolean }>({ isOpen: false, isPastMonth: false });
    const [loading, setLoading] = useState(false);
    const [isDropdownOpen, setIsDropdownOpen] = useState(false);
    const [formErrors, setFormErrors] = useState<ExplanationFormErrors>({});
    const [mode, setMode] = useState<ExplanationMode>('EXPLANATION');
    const [checkinTime, setCheckinTime] = useState('');
    const [checkoutTime, setCheckoutTime] = useState('');
    const activeTab: TabType = sourceTab;

    const reasonRef = useRef<HTMLTextAreaElement>(null);
    const checkinRef = useRef<HTMLInputElement>(null);
    const checkoutRef = useRef<HTMLInputElement>(null);
    const initializedForOpenRef = useRef(false);
    const clientRequestIdRef = useRef(requestCommandId());
    const dialogRef = useModalAccessibility(isOpen, onClose, { closeOnEscape: !loading });
    const swipeBackHandlers = useModalSwipeBack(onClose, loading || confirmDialog.isOpen);
    const navigateFromModal = (tab: TabType) => {
        triggerHaptic('light');
        onClose();
        onNavigate(tab);
    };
    const dateListbox = useListboxNavigation({
        isOpen: isDropdownOpen,
        optionCount: explainableItems.length,
        selectedIndex: explainableItems.findIndex((item) => item.date === selectedDate),
        onOpen: () => setIsDropdownOpen(true),
        onClose: () => setIsDropdownOpen(false),
    });

    const lockDate = data?.systemConfig?.LOCK_DATE ?? TMS_LIMITS.LOCK_DATE;
    const maxPerMonth = data?.systemConfig?.MAX_EXPLANATIONS_PER_MONTH ?? TMS_LIMITS.MAX_EXPLANATIONS_PER_MONTH;
    const selectedItem = useMemo(
        () => selectedDate ? explainableItems.find((item) => item.date === selectedDate) ?? null : null,
        [explainableItems, selectedDate],
    );
    const selectedItemHasMissingTime = Boolean(selectedItem?.missingCheckin || selectedItem?.missingCheckout);
    const isCorrection = mode === 'CORRECTION' && selectedItemHasMissingTime;

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
        if (!isOpen) {
            initializedForOpenRef.current = false;
            return;
        }
        if (initializedForOpenRef.current) return;
        initializedForOpenRef.current = true;
        const initialDate = initialData?.date || '';
        const initialItem = explainableItems.find((item) => item.date === initialDate);
        setSelectedDate(initialDate);
        setReason(initialData?.reason || '');
        setMode(initialItem?.missingCheckin || initialItem?.missingCheckout ? 'CORRECTION' : 'EXPLANATION');
        setCheckinTime(initialItem?.recordedCheckin || '');
        setCheckoutTime(initialItem?.recordedCheckout || '');
        setFormErrors({});
        setIsDropdownOpen(false);
    }, [explainableItems, initialData, isOpen]);

    const handlePreSubmit = () => {
        triggerHaptic('light');
        const requiredErrors: ExplanationFormErrors = {};
        if (!selectedDate) requiredErrors.date = 'Vui lòng chọn ngày cần giải trình.';
        if (reason.trim().length < TMS_LIMITS.REQUEST_REASON_MIN_LENGTH) {
            requiredErrors.reason = `Lý do cần ít nhất ${TMS_LIMITS.REQUEST_REASON_MIN_LENGTH} ký tự.`;
        }
        if (isCorrection && !checkinTime) requiredErrors.checkin = 'Vui lòng nhập giờ check-in thực tế.';
        if (isCorrection && !checkoutTime) requiredErrors.checkout = 'Vui lòng nhập giờ check-out thực tế.';
        if (Object.keys(requiredErrors).length > 0) {
            setFormErrors(requiredErrors);
            window.requestAnimationFrame(() => {
                if (requiredErrors.date) dateListbox.triggerRef.current?.focus();
                else if (requiredErrors.checkin) checkinRef.current?.focus();
                else if (requiredErrors.checkout) checkoutRef.current?.focus();
                else reasonRef.current?.focus();
            });
            onAlert("Thiếu thông tin", isCorrection
                ? "Vui lòng nhập đủ giờ thực tế và lý do điều chỉnh."
                : "Vui lòng chọn ngày và nhập lý do giải trình.", 'error');
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
        const res = await submitExplanation({
            date: selectedDate,
            reason,
            requestType: isCorrection ? 'CORRECTION' : 'EXPLANATION',
            requestedCheckin: isCorrection ? checkinTime : undefined,
            requestedCheckout: isCorrection ? checkoutTime : undefined,
            clientRequestId: clientRequestIdRef.current,
        });

        if (res.success) {
            triggerHaptic('success');
            onAlert("Thành công", isCorrection ? "Đã gửi yêu cầu bổ sung giờ công." : "Đã gửi giải trình.", 'success');
            onSuccess();
            onClose();
        } else {
            triggerHaptic('error');
            onAlert("Lỗi", res.message, 'error');
        }

        setLoading(false);
        setConfirmDialog({ isOpen: false, isPastMonth: false });
    };

    const handleDateSelect = (item: ExplainableAttendanceItem) => {
        triggerHaptic('light');
        setSelectedDate(item.date);
        setReason(item.explainReason || '');
        setMode(item.missingCheckin || item.missingCheckout ? 'CORRECTION' : 'EXPLANATION');
        setCheckinTime(item.recordedCheckin || '');
        setCheckoutTime(item.recordedCheckout || '');
        setFormErrors({});
        setIsDropdownOpen(false);
        window.requestAnimationFrame(() => dateListbox.triggerRef.current?.focus());
    };

    if (!isOpen) return null;

    const firstError = formErrors.date || formErrors.checkin || formErrors.checkout || formErrors.reason || '';
    const quotaTone = monthExplanationsCount >= maxPerMonth
        ? 'ui-field-foot-danger'
        : monthExplanationsCount >= maxPerMonth - 1
            ? 'ui-field-foot-warning'
            : '';

    return (
        <>
            <div
                ref={dialogRef}
                tabIndex={-1}
                className="app-modal-screen app-modal-screen-solid animate-slide-up transition-colors duration-300"
                role="dialog"
                aria-modal="true"
                aria-labelledby="explain-work-title"
                aria-busy={loading}
                data-swipe-surface="modal"
                {...swipeBackHandlers}
            >
                <div className="app-modal-header-layer">
                    <ModalHeader
                        title={isCorrection ? "Điều chỉnh công" : "Giải trình công"}
                        subtitle={`Còn ${Math.max(0, maxPerMonth - monthExplanationsCount)}/${maxPerMonth} lượt trong tháng`}
                        onClose={() => { triggerHaptic('light'); onClose(); }}
                    />
                </div>

                <div className="app-modal-content no-scrollbar">
                    <div className="ui-stack animate-fade-in">
                        {/* What this sheet is for ------------------------- */}
                        <section className="ui-sheet-hero ui-sheet-hero-teal">
                            <span className="ui-sheet-hero-icon" aria-hidden="true">
                                <span className="material-symbols-rounded">edit_document</span>
                            </span>
                            <span className="ui-sheet-hero-body">
                                <span id="explain-work-title" className="ui-sheet-hero-title">{isCorrection ? 'Bổ sung giờ chấm công' : 'Giải trình ngày công'}</span>
                                <span className="ui-sheet-hero-sub">{isCorrection
                                    ? 'Nhập giờ thực tế đã làm để quản lý kiểm tra trước khi cập nhật bảng công.'
                                    : 'Nêu rõ sự việc để quản lý đối soát; giải trình không tự tạo thêm giờ công.'}</span>
                            </span>
                        </section>

                        {/* The form --------------------------------------- */}
                        <div>
                            <div className="ui-label-row">
                                <span className="ui-label">Thông tin giải trình</span>
                                <span className="ui-label">{explainableItems.length} ngày cần xử lý</span>
                            </div>

                            <section className="ui-card ui-card-form ui-card-pad">
                                <p className="sr-only" role="alert" aria-live="assertive">{firstError}</p>

                                <div className="ui-form">
                                    <div className="ui-field">
                                        <label className="ui-field-label ui-field-label-required" htmlFor="explain-date-trigger">Ngày cần giải trình</label>
                                        <button
                                            ref={dateListbox.triggerRef}
                                            id="explain-date-trigger"
                                            type="button"
                                            onClick={() => { triggerHaptic('light'); setIsDropdownOpen((open) => !open); }}
                                            onKeyDown={dateListbox.handleTriggerKeyDown}
                                            className={`ui-control ${formErrors.date ? 'ui-control-invalid' : ''}`.trim()}
                                            aria-haspopup="listbox"
                                            aria-expanded={isDropdownOpen}
                                            aria-controls="explain-date-options"
                                            aria-invalid={!!formErrors.date}
                                            aria-describedby={formErrors.date ? 'explain-date-error' : undefined}
                                            data-modal-escape-layer={isDropdownOpen ? 'true' : undefined}
                                        >
                                            {selectedItem ? (
                                                <>
                                                    <span className="ui-control-value">{formatDateString(selectedDate)}</span>
                                                    <span className="ui-control-flags"><ReasonDisplay reasons={selectedItem.explainReason} /></span>
                                                </>
                                            ) : (
                                                <span className="ui-control-value ui-control-placeholder">Chọn ngày…</span>
                                            )}
                                            <span className={`material-symbols-rounded ui-control-chevron ${isDropdownOpen ? 'ui-control-chevron-open' : ''}`.trim()} aria-hidden="true">expand_more</span>
                                        </button>

                                        {formErrors.date ? (
                                            <p id="explain-date-error" className="ui-field-error">
                                                <span className="material-symbols-rounded" aria-hidden="true">error</span>
                                                {formErrors.date}
                                            </p>
                                        ) : selectedDate ? (
                                            <span className="ui-field-foot">
                                                <span className={quotaTone}>Hạn mức tháng {selectedDate.slice(5, 7)}: {monthExplanationsCount}/{maxPerMonth} đơn</span>
                                                {isPastMonthSelected ? <span className="ui-field-foot-warning">Tháng trước · hạn chót ngày {lockDate}</span> : null}
                                            </span>
                                        ) : null}

                                        {isDropdownOpen && (
                                            <div
                                                id="explain-date-options"
                                                role="listbox"
                                                aria-label="Ngày cần giải trình"
                                                data-modal-escape-layer="true"
                                                className="ui-menu animate-fade-in"
                                            >
                                                {explainableItems.length === 0 ? (
                                                    <p className="ui-menu-empty">Không có ngày nào cần giải trình</p>
                                                ) : (
                                                    explainableItems.map((item, index) => {
                                                        const isSelected = selectedDate === item.date;
                                                        return (
                                                            <button
                                                                ref={dateListbox.registerOption(index)}
                                                                type="button"
                                                                key={item.date}
                                                                role="option"
                                                                aria-selected={isSelected}
                                                                onClick={() => handleDateSelect(item)}
                                                                onKeyDown={(event) => dateListbox.handleOptionKeyDown(event, index)}
                                                                className={`ui-menu-item ${isSelected ? 'ui-menu-item-active' : ''}`.trim()}
                                                            >
                                                                <span className="ui-menu-item-date">{formatDateString(item.date)}</span>
                                                                <span className="ui-menu-item-flags">
                                                                    <ReasonDisplay reasons={item.explainReason} />
                                                                </span>
                                                                {isSelected ? <span className="material-symbols-rounded" aria-hidden="true">check</span> : null}
                                                            </button>
                                                        );
                                                    })
                                                )}
                                            </div>
                                        )}
                                    </div>

                                    {selectedItemHasMissingTime ? (
                                        <div className="ui-field">
                                            <span className="ui-field-label">Cách xử lý</span>
                                            <div className="app-segmented attendance-resolution-switch" role="group" aria-label="Cách xử lý dữ liệu thiếu">
                                                <button
                                                    type="button"
                                                    className={`app-segmented-option ${mode === 'CORRECTION' ? 'app-segmented-option-active' : ''}`.trim()}
                                                    aria-pressed={mode === 'CORRECTION'}
                                                    onClick={() => { setMode('CORRECTION'); setFormErrors((current) => ({ ...current, checkin: undefined, checkout: undefined })); }}
                                                >
                                                    Bổ sung giờ
                                                </button>
                                                <button
                                                    type="button"
                                                    className={`app-segmented-option ${mode === 'EXPLANATION' ? 'app-segmented-option-active' : ''}`.trim()}
                                                    aria-pressed={mode === 'EXPLANATION'}
                                                    onClick={() => { setMode('EXPLANATION'); setFormErrors((current) => ({ ...current, checkin: undefined, checkout: undefined })); }}
                                                >
                                                    Chỉ giải trình
                                                </button>
                                            </div>
                                            <span className="ui-field-foot">“Chỉ giải trình” không cộng giờ công bị thiếu.</span>
                                        </div>
                                    ) : null}

                                    {isCorrection ? (
                                        <div className="ui-form-grid">
                                            <div className="ui-field">
                                                <label className="ui-field-label ui-field-label-required" htmlFor="explain-checkin-time">Giờ check-in thực tế</label>
                                                <input
                                                    ref={checkinRef}
                                                    id="explain-checkin-time"
                                                    type="time"
                                                    required
                                                    className={`ui-control ${formErrors.checkin ? 'ui-control-invalid' : ''}`.trim()}
                                                    value={checkinTime}
                                                    onChange={(event) => { setCheckinTime(event.target.value); setFormErrors((current) => ({ ...current, checkin: undefined })); }}
                                                    aria-invalid={!!formErrors.checkin}
                                                    aria-describedby={formErrors.checkin ? 'explain-checkin-error' : undefined}
                                                />
                                                {formErrors.checkin ? <p id="explain-checkin-error" className="ui-field-error">{formErrors.checkin}</p> : null}
                                            </div>
                                            <div className="ui-field">
                                                <label className="ui-field-label ui-field-label-required" htmlFor="explain-checkout-time">Giờ check-out thực tế</label>
                                                <input
                                                    ref={checkoutRef}
                                                    id="explain-checkout-time"
                                                    type="time"
                                                    required
                                                    className={`ui-control ${formErrors.checkout ? 'ui-control-invalid' : ''}`.trim()}
                                                    value={checkoutTime}
                                                    onChange={(event) => { setCheckoutTime(event.target.value); setFormErrors((current) => ({ ...current, checkout: undefined })); }}
                                                    aria-invalid={!!formErrors.checkout}
                                                    aria-describedby={formErrors.checkout ? 'explain-checkout-error' : undefined}
                                                />
                                                {formErrors.checkout ? <p id="explain-checkout-error" className="ui-field-error">{formErrors.checkout}</p> : null}
                                            </div>
                                        </div>
                                    ) : null}

                                    <div className="ui-field">
                                        <label className="ui-field-label ui-field-label-required" htmlFor="explain-reason-textarea">Lý do giải trình</label>
                                        <textarea
                                            ref={reasonRef}
                                            id="explain-reason-textarea"
                                            required
                                            maxLength={TMS_LIMITS.REQUEST_REASON_MAX_LENGTH}
                                            className={`ui-control ${formErrors.reason ? 'ui-control-invalid' : ''}`.trim()}
                                            placeholder="Mô tả điều đã xảy ra trong ngày này…"
                                            value={reason}
                                            onChange={e => {
                                                setReason(e.target.value);
                                                setFormErrors((current) => ({ ...current, reason: undefined }));
                                            }}
                                            aria-invalid={!!formErrors.reason}
                                            aria-describedby={formErrors.reason ? 'explain-reason-error' : undefined}
                                        />
                                        {formErrors.reason ? (
                                            <p id="explain-reason-error" className="ui-field-error">
                                                <span className="material-symbols-rounded" aria-hidden="true">error</span>
                                                {formErrors.reason}
                                            </p>
                                        ) : (
                                            <span className="ui-field-foot">
                                                <span>Nội dung này đi kèm đơn khi quản lý duyệt.</span>
                                                <span>{reason.length}/{TMS_LIMITS.REQUEST_REASON_MAX_LENGTH}</span>
                                            </span>
                                        )}
                                    </div>
                                </div>
                            </section>
                        </div>

                        {/* Deadline --------------------------------------- */}
                        <p className={`ui-note ${isPastMonthSelected ? 'ui-note-warning' : ''}`.trim()}>
                            <span className="material-symbols-rounded" aria-hidden="true">{isPastMonthSelected ? 'schedule' : 'info'}</span>
                            <span>
                                {isPastMonthSelected
                                    ? `Đơn cho tháng trước phải gửi trước ngày ${lockDate} hàng tháng, nếu không bảng công sẽ bị khoá.`
                                    : `Bảng công tháng chốt vào ngày ${lockDate}. Mỗi tháng gửi tối đa ${maxPerMonth} đơn giải trình.`}
                            </span>
                        </p>

                        {/* Submit ----------------------------------------- */}
                        <button type="button" onClick={handlePreSubmit} disabled={loading} className="ui-cta">
                            {loading ? (
                                <span className="material-symbols-rounded ui-spin" aria-hidden="true">progress_activity</span>
                            ) : (
                                <>
                                    <span className="material-symbols-rounded" aria-hidden="true">send</span>
                                    {isCorrection ? 'Gửi bổ sung giờ' : 'Gửi giải trình'}
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

            <ConfirmDialog
                isOpen={confirmDialog.isOpen}
                title={isCorrection ? "Gửi điều chỉnh công?" : "Gửi giải trình?"}
                message={confirmDialog.isPastMonth
                    ? <>Bạn đang gửi yêu cầu cho <strong>tháng trước</strong>. Đơn này có thể bị tính là trễ hạn.</>
                    : isCorrection
                        ? <>Đề nghị cập nhật ngày <strong>{formatDateString(selectedDate)}</strong> thành <strong>{checkinTime}–{checkoutTime}</strong> sau khi quản lý duyệt.</>
                        : <>Hệ thống sẽ ghi nhận giải trình của bạn cho ngày <strong>{formatDateString(selectedDate)}</strong> mà không tự cộng giờ công.</>
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
