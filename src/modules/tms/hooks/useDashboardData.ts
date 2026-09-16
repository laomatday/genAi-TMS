import { useCallback, useEffect, useRef, useState } from 'react';
import type { DashboardData, Employee } from '@/shared/types';
import { getDashboardData } from '@/modules/tms/services/employee';
import { TMS_LIMITS } from '@/shared/constants';
import { nextDashboardRefreshDelay } from './dashboardRefresh';
import { loadDashboardSnapshot, saveDashboardSnapshot } from '@/modules/tms/services/dashboardSnapshot';

export const useDashboardData = (
  user: Employee,
  onLogout: () => void,
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

  const performFetch = useCallback(async (isInitial = false, requireFresh = false): Promise<boolean> => {
    lastAttemptAtRef.current = Date.now();
    if (!navigator.onLine) {
      setIsOnline(false);
      setError('Đang ngoại tuyến. Dữ liệu sẽ được cập nhật khi có kết nối lại.');
      if (isInitial) setLoading(false);
      return false;
    }

    if (isInitial) setLoading(true);

    try {
      const result = await getDashboardData(currentUserRef.current.employee_id, {
        organizationId: currentUserRef.current.organization_id,
        force: requireFresh,
      });
      if (!result.success || !result.data) {
        setError(result.message || 'Không tải được dữ liệu.');
        return false;
      }

      if (result.data.userProfile?.status !== 'Active') {
        onLogout();
        return true;
      }

      const syncedAt = new Date();
      setError('');
      setIsOnline(true);
      setLastSyncedAt(syncedAt);
      const profileChanged = JSON.stringify(result.data.userProfile) !== JSON.stringify(currentUserRef.current);
      if (profileChanged) {
        currentUserRef.current = result.data.userProfile;
        setCurrentUser(result.data.userProfile);
      }

      const serialized = JSON.stringify(result.data);
      if (serialized !== previousDataRef.current) {
        previousDataRef.current = serialized;
        setData(result.data);
      }
      void saveDashboardSnapshot(result.data.userProfile, result.data, syncedAt);
      return true;
    } catch (caughtError) {
      console.error('Dashboard data fetch error', caughtError);
      setError(caughtError instanceof Error ? caughtError.message : 'Không tải được dữ liệu.');
      return false;
    } finally {
      if (isInitial) setLoading(false);
    }
  }, [onLogout]);

  const fetchData = useCallback(async (isInitial = false, requireFresh = false): Promise<boolean> => {
    const activeRequest = requestInFlightRef.current;
    if (activeRequest) {
      const activeOutcome = await activeRequest;
      if (!requireFresh) return activeOutcome;
      // Another caller may already have queued the required post-action fetch.
      if (requestInFlightRef.current) return requestInFlightRef.current;
    }

    const request = performFetch(isInitial, requireFresh);
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

    const initialize = async () => {
      const snapshot = await loadDashboardSnapshot(currentUserRef.current);
      if (disposed) return;
      if (snapshot) {
        const restoredAt = new Date(snapshot.fetchedAt);
        currentUserRef.current = snapshot.data.userProfile;
        previousDataRef.current = JSON.stringify(snapshot.data);
        setCurrentUser(snapshot.data.userProfile);
        setData(snapshot.data);
        setLastSyncedAt(restoredAt);
        setLoading(false);
      }
      // The sync is not optional, however fresh the snapshot is: it deliberately
      // stores none of the colleague data — no directory, no team queue, no
      // approvals — so a shared device keeps nobody else's details. Painting it
      // and stopping there would leave those screens permanently empty.
      await refreshAndSchedule(!snapshot);
    };

    void initialize();
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
