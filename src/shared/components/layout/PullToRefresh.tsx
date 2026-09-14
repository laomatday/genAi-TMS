import { useRef, useState, type CSSProperties, type ReactNode, type TouchEvent } from 'react';
import { triggerHaptic } from '@/core/utils/helpers';
import Spinner from '@/shared/components/common/Spinner';
import { useToast } from '@/shared/contexts/useToast';

interface PullToRefreshProps {
  onRefresh: () => Promise<void>;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}

type PullToRefreshStyle = CSSProperties & {
  '--pull-distance': string;
  '--pull-opacity': number;
};

const DRAG_START_THRESHOLD = 10;
const REFRESH_THRESHOLD = 60;
const MAX_PULL_DISTANCE = 120;
const DRAG_RESISTANCE = 0.4;

export default function PullToRefresh({
  onRefresh,
  children,
  className = '',
  style = {},
}: PullToRefreshProps) {
  const [pullDistance, setPullDistance] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshStatus, setRefreshStatus] = useState('');
  const touchStartY = useRef<number | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const refreshingRef = useRef(false);
  const { showToast } = useToast();

  const handleTouchStart = (event: TouchEvent<HTMLDivElement>) => {
    const touch = event.touches[0];
    touchStartY.current = contentRef.current?.scrollTop === 0
      ? touch?.clientY ?? null
      : null;
  };

  const handleTouchMove = (event: TouchEvent<HTMLDivElement>) => {
    if (touchStartY.current === null || contentRef.current?.scrollTop !== 0 || isRefreshing) return;

    const touch = event.touches[0];
    if (!touch) return;
    const dragDistance = touch.clientY - touchStartY.current;
    if (dragDistance <= DRAG_START_THRESHOLD) return;

    setPullDistance(Math.min(
      (dragDistance - DRAG_START_THRESHOLD) * DRAG_RESISTANCE,
      MAX_PULL_DISTANCE,
    ));
  };

  const runRefresh = async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setIsRefreshing(true);
    setPullDistance(REFRESH_THRESHOLD);
    setRefreshStatus('Đang cập nhật dữ liệu.');
    triggerHaptic('medium');

    try {
      await onRefresh();
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
      setPullDistance(0);
    }
  };

  const handleTouchEnd = async () => {
    touchStartY.current = null;
    if (pullDistance <= REFRESH_THRESHOLD || isRefreshing) {
      setPullDistance(0);
      return;
    }
    await runRefresh();
  };

  const pullStyle = {
    ...style,
    '--pull-distance': `${pullDistance}px`,
    '--pull-opacity': Math.min(pullDistance / 40, 1),
  } as PullToRefreshStyle;

  return (
    <div
      ref={contentRef}
      className={`pull-to-refresh absolute inset-0 overflow-y-auto no-scrollbar pt-safe pb-safe ${isRefreshing ? 'pull-to-refresh-active' : ''} ${className}`}
      style={pullStyle}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={() => void handleTouchEnd()}
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
