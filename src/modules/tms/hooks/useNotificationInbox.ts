import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Employee } from '@/shared/types';
import { TMS_LIMITS } from '@/shared/constants';
import {
  getNotificationInbox,
  getNotificationUnreadCount,
  markNotificationRead,
  type WorkforceNotification,
} from '@/modules/tms/services/notifications';

interface PendingRequest {
  subject: string;
  promise: Promise<boolean>;
}

export function useNotificationInbox(user: Pick<Employee, 'employee_id' | 'organization_id'>) {
  const [items, setItems] = useState<WorkforceNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const subject = `${user.organization_id || 'unassigned'}:${user.employee_id}`;
  const subjectRef = useRef(subject);
  subjectRef.current = subject;
  const inboxLoadedRef = useRef(false);
  const requestRef = useRef<PendingRequest | null>(null);
  const unreadRequestRef = useRef<PendingRequest | null>(null);

  const refresh = useCallback(async () => {
    if (!navigator.onLine) return false;
    if (requestRef.current?.subject === subject) return requestRef.current.promise;
    const request = (async () => {
      setLoading(true);
      try {
        const inbox = await getNotificationInbox(subject);
        if (subjectRef.current !== subject) return false;
        setItems(inbox.items);
        setUnreadCount(inbox.unread);
        inboxLoadedRef.current = true;
        return true;
      } catch {
        return false;
      } finally {
        if (subjectRef.current === subject) setLoading(false);
      }
    })();
    requestRef.current = { subject, promise: request };
    const result = await request;
    if (requestRef.current?.promise === request) requestRef.current = null;
    return result;
  }, [subject]);

  const refreshUnread = useCallback(async () => {
    if (!navigator.onLine) return false;
    if (unreadRequestRef.current?.subject === subject) return unreadRequestRef.current.promise;
    const request = (async () => {
      try {
        const unread = await getNotificationUnreadCount(subject);
        if (subjectRef.current !== subject) return false;
        setUnreadCount(unread);
        return true;
      } catch {
        return false;
      }
    })();
    unreadRequestRef.current = { subject, promise: request };
    const result = await request;
    if (unreadRequestRef.current?.promise === request) unreadRequestRef.current = null;
    return result;
  }, [subject]);

  useEffect(() => {
    inboxLoadedRef.current = false;
    setItems([]);
    setUnreadCount(0);
    // The closed header only needs the unread badge. Fetch the heavier inbox
    // page lazily when the user opens Notifications (AppShell calls refresh).
    void refreshUnread();

    const refreshCurrentView = () => {
      if (inboxLoadedRef.current) void refresh();
      else void refreshUnread();
    };
    const handleOnlineOrFocus = () => { refreshCurrentView(); };
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') refreshCurrentView();
    }, TMS_LIMITS.DASHBOARD_REFRESH_MS);
    window.addEventListener('online', handleOnlineOrFocus);
    window.addEventListener('focus', handleOnlineOrFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('online', handleOnlineOrFocus);
      window.removeEventListener('focus', handleOnlineOrFocus);
    };
  }, [refresh, refreshUnread]);

  const markRead = useCallback(async (id: string) => {
    const target = items.find((item) => item.id === id);
    if (!target || target.readAt) return true;
    const readAt = new Date().toISOString();
    setItems((current) => current.map((item) => item.id === id ? { ...item, readAt } : item));
    setUnreadCount((count) => Math.max(0, count - 1));
    try {
      await markNotificationRead(id);
      return true;
    } catch {
      void refresh();
      return false;
    }
  }, [items, refresh]);

  const markAllRead = useCallback(async () => {
    if (unreadCount === 0) return true;
    const readAt = new Date().toISOString();
    setItems((current) => current.map((item) => item.readAt ? item : { ...item, readAt }));
    setUnreadCount(0);
    try {
      await markNotificationRead();
      return true;
    } catch {
      void refresh();
      return false;
    }
  }, [refresh, unreadCount]);

  return useMemo(() => ({ items, unreadCount, loading, refresh, markRead, markAllRead }), [
    items,
    loading,
    markAllRead,
    markRead,
    refresh,
    unreadCount,
  ]);
}
