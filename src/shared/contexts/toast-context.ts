import { createContext } from 'react';

export type ToastType = 'info' | 'success' | 'warning' | 'error';
interface ToastAction {
  label: string;
  onClick: () => void | Promise<void>;
}
export interface ToastData {
  title: string;
  body: string;
  type: ToastType;
  /** Set to 0 to keep the toast visible until it is dismissed. */
  durationMs?: number;
  action?: ToastAction;
  dismissible?: boolean;
}
export interface ToastContextValue { showToast: (data: ToastData) => void; }

export const ToastContext = createContext<ToastContextValue | undefined>(undefined);
