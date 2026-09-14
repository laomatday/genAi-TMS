import { useCallback, useRef, useState, type CSSProperties, type ReactNode, type TouchEvent } from 'react';
import { triggerHaptic } from '@/core/utils/helpers';
import Spinner from '@/shared/components/common/Spinner';
import { useToast } from '@/shared/contexts/useToast';
import { TMS_LIMITS } from '@/shared/constants';
import {
  resolveGestureAxis,
  shouldIgnoreHorizontalSwipe,
  type GestureAxis,
  type GesturePoint,
} from '@/shared/gestures/horizontalSwipe';

interface PullToRefreshProps {
  onRefresh: () => Promise<boolean | void>;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}

type PullToRefreshStyle = CSSProperties & {
  '--pull-distance': string;
  '--pull-opacity': number;
};

interface PullGesture {
  start: GesturePoint;
  axis: GestureAxis;
}

export default function PullToRefresh({
  onRefresh,
  children,
  className = '',
  style = {},
}: PullToRefreshProps) {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshStatus, setRefreshStatus] = useState('');
  const contentRef = useRef<HTMLDivElement>(null);
  const refreshingRef = useRef(false);
  const gestureRef = useRef<PullGesture | null>(null);
  const pullDistanceRef = useRef(0);
  const thresholdHapticRef = useRef(false);
  const { showToast } = useToast();

  const setVisualPullDistance = useCallback((distance: number) => {
    const nextDistance = Math.max(0, distance);
    pullDistanceRef.current = nextDistance;
    const element = contentRef.current;
    if (!element) return;
    element.style.setProperty('--pull-distance', `${nextDistance}px`);
    element.style.setProperty('--pull-opacity', String(Math.min(nextDistance / 40, 1)));
  }, []);

  const resetGesture = useCallback(() => {
    gestureRef.current = null;
    thresholdHapticRef.current = false;
  }, []);

  const handleTouchStart = (event: TouchEvent<HTMLDivElement>) => {
    resetGesture();
    if (
      event.touches.length !== 1
      || refreshingRef.current
      || (contentRef.current?.scrollTop ?? 0) > 0
      || shouldIgnoreHorizontalSwipe(event.target, event.currentTarget)
    ) return;
    const touch = event.touches[0];
    if (!touch) return;
    gestureRef.current = {
      start: { x: touch.clientX, y: touch.clientY, time: event.timeStamp },
      axis: 'pending',
    };
  };

  const handleTouchMove = (event: TouchEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || event.touches.length !== 1 || refreshingRef.current) return;
    const touch = event.touches[0];
    if (!touch) return;
    const current = { x: touch.clientX, y: touch.clientY, time: event.timeStamp };
    if (gesture.axis === 'pending') {
      gesture.axis = resolveGestureAxis(gesture.start, current, {
        lockDistancePx: TMS_LIMITS.TOUCH_AXIS_LOCK_PX,
        dominanceRatio: TMS_LIMITS.TOUCH_AXIS_DOMINANCE_RATIO,
      });
    }
    if (gesture.axis === 'horizontal') {
      setVisualPullDistance(0);
      return;
    }
    if (gesture.axis !== 'vertical' || (contentRef.current?.scrollTop ?? 0) > 0) return;

    const dragDistance = current.y - gesture.start.y;
    if (dragDistance <= TMS_LIMITS.PULL_REFRESH_START_PX) {
      setVisualPullDistance(0);
      return;
    }
    event.preventDefault();
    const visualDistance = Math.min(
      (dragDistance - TMS_LIMITS.PULL_REFRESH_START_PX) * TMS_LIMITS.PULL_REFRESH_RESISTANCE,
      TMS_LIMITS.PULL_REFRESH_MAX_PX,
    );
    setVisualPullDistance(visualDistance);
    if (visualDistance >= TMS_LIMITS.PULL_REFRESH_TRIGGER_PX && !thresholdHapticRef.current) {
      thresholdHapticRef.current = true;
      triggerHaptic('light');
    } else if (visualDistance < TMS_LIMITS.PULL_REFRESH_TRIGGER_PX) {
      thresholdHapticRef.current = false;
    }
  };

  const runRefresh = async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setIsRefreshing(true);
    setVisualPullDistance(TMS_LIMITS.PULL_REFRESH_TRIGGER_PX);
    setRefreshStatus('Đang cập nhật dữ liệu.');
    triggerHaptic('medium');

    try {
      const refreshed = await onRefresh();
      if (refreshed === false) throw new Error('Dashboard refresh failed.');
      setRefreshStatus('Dữ liệu đã được cập nhật.');
      triggerHaptic('success');
    } catch (error) {
      console.error('Pull-to-refresh failed', error);
      setRefreshStatus('Không thể cập nhật dữ liệu. Vui lòng thử lại.');
      showToast({
        title: 'Cập nhật thất bại',
        body: 'Vui lòng kiểm tra kết nối rồi thử lại.',
        type: 'error',
        durationMs: 7_000,
        action: { label: 'Thử lại', onClick: () => void runRefresh() },
      });
      triggerHaptic('error');
    } finally {
      refreshingRef.current = false;
      setIsRefreshing(false);
      setVisualPullDistance(0);
    }
  };

  const handleTouchEnd = async () => {
    const shouldRefresh = pullDistanceRef.current >= TMS_LIMITS.PULL_REFRESH_TRIGGER_PX;
    resetGesture();
    if (!shouldRefresh || refreshingRef.current) {
      setVisualPullDistance(0);
      return;
    }
    await runRefresh();
  };

  const handleTouchCancel = () => {
    resetGesture();
    if (!refreshingRef.current) setVisualPullDistance(0);
  };

  const pullStyle = {
    ...style,
    '--pull-distance': `${pullDistanceRef.current}px`,
    '--pull-opacity': Math.min(pullDistanceRef.current / 40, 1),
  } as PullToRefreshStyle;

  return (
    <div
      ref={contentRef}
      className={`pull-to-refresh absolute inset-0 overflow-y-auto no-scrollbar pt-safe pb-safe ${isRefreshing ? 'pull-to-refresh-active' : ''} ${className}`}
      style={pullStyle}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={() => void handleTouchEnd()}
      onTouchCancel={handleTouchCancel}
      aria-busy={isRefreshing}
    >
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{refreshStatus}</p>
      <button
        type="button"
        onClick={() => void runRefresh()}
        disabled={isRefreshing}
        className="refresh-fab"
        aria-label={isRefreshing ? 'Đang làm mới dữ liệu' : 'Làm mới dữ liệu'}
        title="Làm mới dữ liệu"
      >
        <span className={`material-symbols-rounded text-lg ${isRefreshing ? 'animate-spin' : ''}`} aria-hidden="true">{isRefreshing ? 'progress_activity' : 'refresh'}</span>
        {isRefreshing ? 'Đang cập nhật' : 'Làm mới'}
      </button>
      <div className="pull-to-refresh-indicator w-full flex items-center justify-center overflow-hidden absolute top-0 left-0 z-0 pointer-events-none" aria-hidden="true">
        {isRefreshing ? (
          <Spinner size="md" />
        ) : (
          <span className="material-symbols-rounded text-primary text-3xl animate-bounce">arrow_downward</span>
        )}
      </div>
      <div className="pull-to-refresh-content relative z-10 min-h-full">{children}</div>
    </div>
  );
}
