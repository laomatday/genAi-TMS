import { useCallback, useEffect, useRef, useState } from 'react';
import type { DashboardData, Employee } from '@/shared/types';
import { getDashboardData } from '@/modules/tms/services/employee';
import { getCurrentTimeStr, timeToMinutes, toISODateString, triggerHaptic } from '@/core/utils/helpers';
import { scopedStorageKey, TMS_LIMITS } from '@/shared/constants';
import { nextDashboardRefreshDelay } from './dashboardRefresh';

export const useDashboardData = (
  user: Employee,
  onLogout: () => void,
  onNotification?: (title: string, body: string) => void,
) => {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [currentUser, setCurrentUser] = useState(user);
  const [isOnline, setIsOnline] = useState(() => navigator.onLine);
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);
  const currentUserRef = useRef(user);
  const previousDataRef = useRef('');
  const requestInFlightRef = useRef<Promise<boolean> | null>(null);
  const lastAttemptAtRef = useRef(0);
  const refreshRunnerRef = useRef<((isInitial?: boolean) => Promise<boolean>) | null>(null);

  useEffect(() => {
    currentUserRef.current = user;
    setCurrentUser(user);
  }, [user]);

  const checkShiftEndReminder = useCallback((nextData: DashboardData) => {
    const today = toISODateString(new Date());
    const activeSession = nextData.history.history.find((row) => row.date === today && !row.time_out);
    if (!activeSession?.shift_end) return;

    const shiftEndMinutes = timeToMinutes(activeSession.shift_end);
    const currentMinutes = timeToMinutes(getCurrentTimeStr());
    if (currentMinutes <= shiftEndMinutes + TMS_LIMITS.CHECKOUT_REMINDER_DELAY_MINUTES) return;

    const reminderKey = scopedStorageKey(`remind_checkout_${today}`, currentUserRef.current);
    if (localStorage.getItem(reminderKey)) return;

    const title = 'Nhắc nhở Check-out';
    const body = `Ca làm việc của bạn đã kết thúc lúc ${activeSession.shift_end}. Vui lòng Check-out!`;
    if (onNotification) {
      triggerHaptic('warning');
      onNotification(title, body);
    }
    localStorage.setItem(reminderKey, 'true');
  }, [onNotification]);

  const performFetch = useCallback(async (isInitial = false): Promise<boolean> => {
    lastAttemptAtRef.current = Date.now();
    if (!navigator.onLine) {
      setIsOnline(false);
      setError('Đang ngoại tuyến. Dữ liệu sẽ được cập nhật khi có kết nối lại.');
      if (isInitial) setLoading(false);
      return false;
    }

    if (isInitial) setLoading(true);

    try {
      const result = await getDashboardData(currentUserRef.current.employee_id);
      if (!result.success || !result.data) {
        setError(result.message || 'Không tải được dữ liệu.');
        return false;
      }

      if (result.data.userProfile?.status !== 'Active') {
        onLogout();
        return true;
      }

      setError('');
      setIsOnline(true);
      setLastSyncedAt(new Date());
      const profileChanged = JSON.stringify(result.data.userProfile) !== JSON.stringify(currentUserRef.current);
      if (profileChanged) {
        currentUserRef.current = result.data.userProfile;
        setCurrentUser(result.data.userProfile);
      }

      const serialized = JSON.stringify(result.data);
      if (serialized !== previousDataRef.current) {
        previousDataRef.current = serialized;
        setData(result.data);
        checkShiftEndReminder(result.data);
      }
      return true;
    } catch (caughtError) {
      console.error('Dashboard data fetch error', caughtError);
      setError(caughtError instanceof Error ? caughtError.message : 'Không tải được dữ liệu.');
      return false;
    } finally {
      if (isInitial) setLoading(false);
    }
  }, [checkShiftEndReminder, onLogout]);

  const fetchData = useCallback(async (isInitial = false, requireFresh = false): Promise<boolean> => {
    const activeRequest = requestInFlightRef.current;
    if (activeRequest) {
      const activeOutcome = await activeRequest;
      if (!requireFresh) return activeOutcome;
      // Another caller may already have queued the required post-action fetch.
      if (requestInFlightRef.current) return requestInFlightRef.current;
    }

    const request = performFetch(isInitial);
    const trackedRequest = request.finally(() => {
      if (requestInFlightRef.current === trackedRequest) requestInFlightRef.current = null;
    });
    requestInFlightRef.current = trackedRequest;
    return trackedRequest;
  }, [performFetch]);

  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;
    let consecutiveFailures = 0;

    const clearScheduledRefresh = () => {
      if (timer === undefined) return;
      window.clearTimeout(timer);
      timer = undefined;
    };

    const scheduleRefresh = () => {
      clearScheduledRefresh();
      if (disposed || document.visibilityState === 'hidden' || !navigator.onLine) return;
      timer = window.setTimeout(async () => {
        timer = undefined;
        const outcome = await fetchData(false);
        if (disposed) return;
        consecutiveFailures = outcome ? 0 : consecutiveFailures + 1;
        scheduleRefresh();
      }, nextDashboardRefreshDelay(consecutiveFailures));
    };

    const refreshAndSchedule = async (isInitial = false, requireFresh = false) => {
      clearScheduledRefresh();
      const outcome = await fetchData(isInitial, requireFresh);
      if (disposed) return outcome;
      consecutiveFailures = outcome ? 0 : consecutiveFailures + 1;
      scheduleRefresh();
      return outcome;
    };
    const manualRefresh = (isInitial = false) => refreshAndSchedule(isInitial, true);
    refreshRunnerRef.current = manualRefresh;

    const refreshIfStale = () => {
      if (document.visibilityState === 'hidden' || !navigator.onLine) return;
      if (Date.now() - lastAttemptAtRef.current >= TMS_LIMITS.DASHBOARD_VISIBLE_STALE_MS) {
        void refreshAndSchedule(false);
      } else if (timer === undefined) {
        scheduleRefresh();
      }
    };

    const handleOffline = () => {
      clearScheduledRefresh();
      setIsOnline(false);
      setError('Đang ngoại tuyến. Dữ liệu sẽ được cập nhật khi có kết nối lại.');
    };
    const handleOnline = () => {
      setIsOnline(true);
      if (document.visibilityState === 'hidden') return;
      void refreshAndSchedule(false);
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') clearScheduledRefresh();
      else refreshIfStale();
    };

    void refreshAndSchedule(true);
    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);
    window.addEventListener('focus', refreshIfStale);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      disposed = true;
      if (refreshRunnerRef.current === manualRefresh) refreshRunnerRef.current = null;
      clearScheduledRefresh();
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('focus', refreshIfStale);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [fetchData]);

  const refresh = useCallback(async (isInitial = false) => {
    const outcome = refreshRunnerRef.current
      ? await refreshRunnerRef.current(isInitial)
      : await fetchData(isInitial, true);
    return outcome;
  }, [fetchData]);

  return { data, loading, error, currentUser, isOnline, lastSyncedAt, refresh };
};
