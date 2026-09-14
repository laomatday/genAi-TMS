import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ToastContext, type ToastData, type ToastType } from './toast-context';

const TOAST_DURATION_MS: Record<ToastType, number> = {
  success: 3_500,
  info: 4_000,
  warning: 5_000,
  error: 7_000,
};
const MAX_QUEUED_TOASTS = 5;
const TOAST_ICONS: Record<ToastType, string> = {
  success: 'check_circle',
  error: 'cancel',
  warning: 'warning',
  info: 'notifications',
};

interface QueuedToast extends ToastData { id: number; }

export const ToastProvider = ({ children }: { children: ReactNode }) => {
  const [toastQueue, setToastQueue] = useState<QueuedToast[]>([]);
  const nextToastId = useRef(0);
  const activeToast = toastQueue[0] ?? null;

  const showToast = useCallback((data: ToastData) => {
    const queuedToast = { ...data, id: nextToastId.current++ };
    setToastQueue((current) => current.length >= MAX_QUEUED_TOASTS
      ? [...current.slice(0, MAX_QUEUED_TOASTS - 1), queuedToast]
      : [...current, queuedToast]);
  }, []);

  const closeToast = useCallback(() => {
    setToastQueue((current) => current.slice(1));
  }, []);

  useEffect(() => {
    if (!activeToast) return;
    const duration = activeToast.durationMs ?? TOAST_DURATION_MS[activeToast.type];
    if (duration <= 0) return;
    const timer = window.setTimeout(closeToast, duration);
    return () => window.clearTimeout(timer);
  }, [activeToast, closeToast]);

  const handleAction = () => {
    const action = activeToast?.action;
    closeToast();
    if (action) void action.onClick();
  };

  return <ToastContext.Provider value={{ showToast }}>
    {children}
    {activeToast ? <div key={activeToast.id} data-modal-exempt className={`app-toast app-toast-${activeToast.type}`} role={activeToast.type === 'error' ? 'alert' : 'status'} aria-live={activeToast.type === 'error' ? 'assertive' : 'polite'} aria-atomic="true">
      <div className="app-toast-icon"><span className="material-symbols-rounded" aria-hidden="true">{TOAST_ICONS[activeToast.type]}</span></div>
      <div className="app-toast-copy"><strong>{activeToast.title}</strong><p>{activeToast.body}</p></div>
      {activeToast.action ? <button type="button" onClick={handleAction} className="app-toast-action">{activeToast.action.label}</button> : null}
      {activeToast.dismissible !== false ? <button type="button" className="app-toast-close" onClick={closeToast} aria-label="Đóng thông báo"><span className="material-symbols-rounded" aria-hidden="true">close</span></button> : null}
    </div> : null}
  </ToastContext.Provider>;
};
