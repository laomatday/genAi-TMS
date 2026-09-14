import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  Suspense,
  type MouseEventHandler,
  type ReactNode,
  type TouchEventHandler,
} from 'react';
import { flushSync } from 'react-dom';
import { TMS_LIMITS } from '@/shared/constants';
import {
  detectHorizontalSwipe,
  recentHorizontalVelocity,
  resistedSwipeOffset,
  resolveGestureAxis,
  shouldIgnoreHorizontalSwipe,
  type GestureAxis,
  type GesturePoint,
} from '@/shared/gestures/horizontalSwipe';
import { EMPLOYEE_NAV_TABS, type EmployeeNavTab } from './BottomNav';

interface Props {
  activeTab: EmployeeNavTab;
  disabled?: boolean;
  onChange: (tab: EmployeeNavTab) => void;
  renderPage: (tab: EmployeeNavTab, isActive: boolean) => ReactNode;
}

interface ActiveGesture {
  axis: GestureAxis;
  last: GesturePoint;
  samples: GesturePoint[];
  start: GesturePoint;
  width: number;
}

const pointFromTouch = (touch: { clientX: number; clientY: number }, time: number): GesturePoint => ({
  x: touch.clientX,
  y: touch.clientY,
  time,
});

export function adjacentPagerIndex(activeIndex: number, direction: 'left' | 'right', length: number) {
  const target = activeIndex + (direction === 'left' ? 1 : -1);
  return target >= 0 && target < length ? target : null;
}

/**
 * A three-panel pager keeps the neighbouring screens mounted while the finger
 * moves. Only this component owns the horizontal gesture; nested tabs and
 * modals use explicit controls, so a single touch can never trigger two routes.
 */
export default function EmployeePager({ activeTab, disabled = false, onChange, renderPage }: Props) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const gestureRef = useRef<ActiveGesture | null>(null);
  const settleTimerRef = useRef<number | null>(null);
  const clickSuppressionTimerRef = useRef<number | null>(null);
  const suppressClickRef = useRef(false);
  const activeIndex = EMPLOYEE_NAV_TABS.indexOf(activeTab);

  const visibleTabs = useMemo(() => (
    [activeIndex - 1, activeIndex, activeIndex + 1]
      .map((index) => ({ index, tab: EMPLOYEE_NAV_TABS[index] }))
      .filter((entry): entry is { index: number; tab: EmployeeNavTab } => Boolean(entry.tab))
  ), [activeIndex]);

  const clearSettleTimer = useCallback(() => {
    if (settleTimerRef.current !== null) {
      window.clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
  }, []);

  const clearClickSuppression = useCallback(() => {
    if (clickSuppressionTimerRef.current !== null) {
      window.clearTimeout(clickSuppressionTimerRef.current);
      clickSuppressionTimerRef.current = null;
    }
    suppressClickRef.current = false;
  }, []);

  const suppressSyntheticClick = useCallback(() => {
    suppressClickRef.current = true;
    if (clickSuppressionTimerRef.current !== null) window.clearTimeout(clickSuppressionTimerRef.current);
    clickSuppressionTimerRef.current = window.setTimeout(
      clearClickSuppression,
      TMS_LIMITS.SWIPE_CLICK_SUPPRESSION_MS,
    );
  }, [clearClickSuppression]);

  const clearSurface = useCallback((surface = surfaceRef.current) => {
    if (!surface) return;
    surface.style.removeProperty('--pager-offset-x');
    delete surface.dataset.pagerPhase;
  }, []);

  const settle = useCallback((targetIndex: number | null, offset: number) => {
    const surface = surfaceRef.current;
    if (!surface) return;
    clearSettleTimer();
    surface.dataset.pagerPhase = 'settling';
    surface.style.setProperty('--pager-offset-x', `${offset}px`);
    settleTimerRef.current = window.setTimeout(() => {
      settleTimerRef.current = null;
      if (targetIndex !== null) {
        const targetTab = EMPLOYEE_NAV_TABS[targetIndex];
        if (targetTab) flushSync(() => onChange(targetTab));
      }
      clearSurface(surface);
    }, TMS_LIMITS.SWIPE_SETTLE_MS);
  }, [clearSettleTimer, clearSurface, onChange]);

  const cancelGesture = useCallback(() => {
    const gesture = gestureRef.current;
    gestureRef.current = null;
    clearSettleTimer();
    clearClickSuppression();
    if (gesture?.axis === 'horizontal') settle(null, 0);
    else clearSurface();
  }, [clearClickSuppression, clearSettleTimer, clearSurface, settle]);

  useLayoutEffect(() => {
    clearSettleTimer();
    clearSurface();
  }, [activeTab, clearSettleTimer, clearSurface]);
  useEffect(() => {
    if (disabled) cancelGesture();
  }, [cancelGesture, disabled]);
  useEffect(() => () => {
    clearSettleTimer();
    clearClickSuppression();
    clearSurface();
  }, [clearClickSuppression, clearSettleTimer, clearSurface]);

  const onTouchStart = useCallback<TouchEventHandler<HTMLDivElement>>((event) => {
    clearSettleTimer();
    clearSurface(event.currentTarget);
    gestureRef.current = null;
    clearClickSuppression();
    if (disabled || event.touches.length !== 1 || shouldIgnoreHorizontalSwipe(event.target, event.currentTarget)) return;
    const touch = event.touches[0];
    if (!touch) return;
    const start = pointFromTouch(touch, event.timeStamp);
    gestureRef.current = {
      axis: 'pending',
      last: start,
      samples: [start],
      start,
      width: event.currentTarget.clientWidth || window.innerWidth,
    };
  }, [clearClickSuppression, clearSettleTimer, clearSurface, disabled]);

  const onTouchMove = useCallback<TouchEventHandler<HTMLDivElement>>((event) => {
    const gesture = gestureRef.current;
    if (!gesture || disabled || event.touches.length !== 1) return;
    const touch = event.touches[0];
    if (!touch) return;
    const current = pointFromTouch(touch, event.timeStamp);
    gesture.last = current;
    gesture.samples.push(current);
    const sampleCutoff = current.time - TMS_LIMITS.SWIPE_VELOCITY_LOOKBACK_MS * 2;
    while (gesture.samples.length > 2 && (gesture.samples[1]?.time ?? Infinity) < sampleCutoff) {
      gesture.samples.shift();
    }
    if (gesture.axis === 'pending') {
      gesture.axis = resolveGestureAxis(gesture.start, current, {
        lockDistancePx: TMS_LIMITS.TOUCH_AXIS_LOCK_PX,
        dominanceRatio: TMS_LIMITS.TOUCH_AXIS_DOMINANCE_RATIO,
      });
    }
    if (gesture.axis !== 'horizontal') return;

    event.preventDefault();
    event.stopPropagation();
    suppressSyntheticClick();
    const movementX = current.x - gesture.start.x;
    const direction = movementX < 0 ? 'left' : 'right';
    const allowed = adjacentPagerIndex(activeIndex, direction, EMPLOYEE_NAV_TABS.length) !== null;
    const visualOffset = resistedSwipeOffset(movementX, gesture.width, allowed);
    event.currentTarget.dataset.pagerPhase = 'dragging';
    event.currentTarget.style.setProperty('--pager-offset-x', `${visualOffset}px`);
  }, [activeIndex, disabled, suppressSyntheticClick]);

  const onTouchEnd = useCallback<TouchEventHandler<HTMLDivElement>>((event) => {
    const gesture = gestureRef.current;
    gestureRef.current = null;
    const touch = event.changedTouches[0];
    if (!gesture || !touch || disabled) {
      cancelGesture();
      return;
    }
    const end = pointFromTouch(touch, event.timeStamp);
    gesture.samples.push(end);
    const finalAxis = gesture.axis === 'pending'
      ? resolveGestureAxis(gesture.start, end, {
        lockDistancePx: TMS_LIMITS.TOUCH_AXIS_LOCK_PX,
        dominanceRatio: TMS_LIMITS.TOUCH_AXIS_DOMINANCE_RATIO,
      })
      : gesture.axis;
    const direction = detectHorizontalSwipe(
      gesture.start,
      end,
      gesture.width,
      {
        lockDistancePx: TMS_LIMITS.TOUCH_AXIS_LOCK_PX,
        dominanceRatio: TMS_LIMITS.TOUCH_AXIS_DOMINANCE_RATIO,
        minDistancePx: TMS_LIMITS.SWIPE_NAVIGATION_PX,
        viewportRatio: TMS_LIMITS.SWIPE_NAVIGATION_VIEWPORT_RATIO,
        maxDistancePx: TMS_LIMITS.SWIPE_MAX_THRESHOLD_PX,
        maxDurationMs: TMS_LIMITS.SWIPE_MAX_DURATION_MS,
        minVelocityPxMs: TMS_LIMITS.SWIPE_MIN_VELOCITY_PX_MS,
        flingVelocityPxMs: TMS_LIMITS.SWIPE_FLING_VELOCITY_PX_MS,
        projectionMs: TMS_LIMITS.SWIPE_PROJECTION_MS,
        longSwipeMultiplier: TMS_LIMITS.SWIPE_LONG_DISTANCE_MULTIPLIER,
      },
      recentHorizontalVelocity(gesture.samples, TMS_LIMITS.SWIPE_VELOCITY_LOOKBACK_MS),
    );
    const targetIndex = direction
      ? adjacentPagerIndex(activeIndex, direction, EMPLOYEE_NAV_TABS.length)
      : null;
    if (finalAxis !== 'horizontal' || !direction || targetIndex === null) {
      if (finalAxis === 'horizontal') settle(null, 0);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    settle(targetIndex, direction === 'left' ? -gesture.width : gesture.width);
  }, [activeIndex, cancelGesture, disabled, settle]);

  const onClickCapture = useCallback<MouseEventHandler<HTMLDivElement>>((event) => {
    if (!suppressClickRef.current) return;
    clearClickSuppression();
    event.preventDefault();
    event.stopPropagation();
  }, [clearClickSuppression]);

  return (
    <div
      ref={surfaceRef}
      className="employee-pager"
      onClickCapture={onClickCapture}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={cancelGesture}
    >
      {visibleTabs.map(({ index, tab }) => {
        const position = index - activeIndex;
        const positionName = position < 0 ? 'previous' : position > 0 ? 'next' : 'current';
        return (
          <section
            key={tab}
            className={`employee-pager-panel employee-pager-panel-${positionName}`}
            aria-hidden={position !== 0}
            inert={position !== 0}
          >
            <Suspense fallback={<div className="app-loading-screen" aria-label="Đang tải trang" />}>
              {renderPage(tab, position === 0)}
            </Suspense>
          </section>
        );
      })}
    </div>
  );
}
