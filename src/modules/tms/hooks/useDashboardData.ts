import { useCallback, useEffect, useRef, useState } from 'react';
import type { DashboardData, Employee } from '@/shared/types';
import { getDashboardData } from '@/modules/tms/services/employee';
import { getCurrentTimeStr, timeToMinutes, toISODateString, triggerHaptic } from '@/core/utils/helpers';
import { TMS_LIMITS } from '@/shared/constants';

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
  const requestInFlightRef = useRef(false);

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

    const reminderKey = `remind_checkout_${today}`;
    if (localStorage.getItem(reminderKey)) return;

    const title = 'Nhắc nhở Check-out';
    const body = `Ca làm việc của bạn đã kết thúc lúc ${activeSession.shift_end}. Vui lòng Check-out!`;
    if (onNotification) {
      triggerHaptic('warning');
      onNotification(title, body);
    }
    localStorage.setItem(reminderKey, 'true');
  }, [onNotification]);

  const fetchData = useCallback(async (isInitial = false) => {
    if (requestInFlightRef.current) return;
    if (!navigator.onLine) {
      setIsOnline(false);
      setError('Đang ngoại tuyến. Dữ liệu sẽ được cập nhật khi có kết nối lại.');
      if (isInitial) setLoading(false);
      return;
    }

    requestInFlightRef.current = true;
    if (isInitial) setLoading(true);

    try {
      const result = await getDashboardData(currentUserRef.current.employee_id);
      if (!result.success || !result.data) {
        setError(result.message || 'Không tải được dữ liệu.');
        return;
      }

      if (result.data.userProfile?.status !== 'Active') {
        onLogout();
        return;
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
    } catch (caughtError) {
      console.error('Dashboard data fetch error', caughtError);
      setError(caughtError instanceof Error ? caughtError.message : 'Không tải được dữ liệu.');
    } finally {
      requestInFlightRef.current = false;
      if (isInitial) setLoading(false);
    }
  }, [checkShiftEndReminder, onLogout]);

  useEffect(() => {
    void fetchData(true);
    const interval = window.setInterval(() => void fetchData(false), TMS_LIMITS.DASHBOARD_REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [fetchData]);

  useEffect(() => {
    const handleOffline = () => {
      setIsOnline(false);
      setError('Đang ngoại tuyến. Dữ liệu sẽ được cập nhật khi có kết nối lại.');
    };
    const handleOnline = () => {
      setIsOnline(true);
      void fetchData(false);
    };
    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);
    return () => {
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
    };
  }, [fetchData]);

  return { data, loading, error, currentUser, isOnline, lastSyncedAt, refresh: fetchData };
};
