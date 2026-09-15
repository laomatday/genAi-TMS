import {
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type MouseEventHandler,
  type ReactNode,
  type TouchEventHandler,
  type UIEventHandler,
} from 'react';
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
import {
  createSubPagerRegistry,
  resolveSwipeTarget,
  SubPagerProvider,
} from '@/modules/tms/navigation/subPager';
import { EMPLOYEE_NAV_TABS, type EmployeeNavTab } from './BottomNav';

interface Props {
  activeTab: EmployeeNavTab;
  disabled?: boolean;
  navigationResetVersion: number;
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

export interface PagerTransitionState {
  generation: number;
  phase: 'idle' | 'dragging' | 'settling';
  targetIndex: number | null;
}

export type PagerTransitionAction =
  | { type: 'drag' }
  | { type: 'settle'; targetIndex: number | null }
  | { type: 'reset' }
  | { type: 'finish'; generation: number };

export const INITIAL_PAGER_TRANSITION_STATE: PagerTransitionState = {
  generation: 0,
  phase: 'idle',
  targetIndex: null,
};

/** Delayed callbacks from an invalidated gesture must be harmless. */
export function reducePagerTransition(
  state: PagerTransitionState,
  action: PagerTransitionAction,
): PagerTransitionState {
  switch (action.type) {
    case 'drag':
      return { ...state, phase: 'dragging', targetIndex: null };
    case 'settle':
      return {
        generation: state.generation + 1,
        phase: 'settling',
        targetIndex: action.targetIndex,
      };
    case 'reset':
      return {
        generation: state.generation + 1,
        phase: 'idle',
        targetIndex: null,
      };
    case 'finish':
      if (action.generation !== state.generation || state.phase !== 'settling') return state;
      return { ...state, phase: 'idle', targetIndex: null };
  }
}

const pointFromTouch = (touch: { clientX: number; clientY: number }, time: number): GesturePoint => ({
  x: touch.clientX,
  y: touch.clientY,
  time,
});

interface ResettablePagerSurface {
  dataset: { pagerPhase?: string };
  scrollLeft: number;
  style: { removeProperty: (property: string) => unknown };
}

/**
 * Clear both the gesture transform and any native horizontal scroll. Browsers
 * may scroll an overflow-hidden ancestor when a descendant calls
 * scrollIntoView(), so transform state alone is not a complete reset.
 */
export function resetPagerSurface(surface: ResettablePagerSurface) {
  surface.scrollLeft = 0;
  surface.style.removeProperty('--pager-offset-x');
  delete surface.dataset.pagerPhase;
}

export function adjacentPagerIndex(activeIndex: number, direction: 'left' | 'right', length: number) {
  const target = activeIndex + (direction === 'left' ? 1 : -1);
  return target >= 0 && target < length ? target : null;
}

/**
 * Keeps one neighbour on either side so the next screen follows the finger.
 * Every external navigation invalidates the active generation before paint.
 */
export default function EmployeePager({
  activeTab,
  disabled = false,
  navigationResetVersion,
  onChange,
  renderPage,
}: Props) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  // Pages with segmented views of their own register here, so a swipe walks
  // those before it moves to the next tab.
  const subPagerRef = useRef(createSubPagerRegistry());
  const gestureRef = useRef<ActiveGesture | null>(null);
  const settleTimerRef = useRef<number | null>(null);
  const clickSuppressionTimerRef = useRef<number | null>(null);
  const suppressClickRef = useRef(false);
  const transitionRef = useRef<PagerTransitionState>(INITIAL_PAGER_TRANSITION_STATE);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const activeIndex = EMPLOYEE_NAV_TABS.indexOf(activeTab);
  const visibleTabs = useMemo(() => (
    [activeIndex - 1, activeIndex, activeIndex + 1]
      .map((index) => ({ index, tab: EMPLOYEE_NAV_TABS[index] }))
      .filter((entry): entry is { index: number; tab: EmployeeNavTab } => Boolean(entry.tab))
  ), [activeIndex]);

  const transition = useCallback((action: PagerTransitionAction) => {
    transitionRef.current = reducePagerTransition(transitionRef.current, action);
    return transitionRef.current;
  }, []);

  const clearSettleTimer = useCallback(() => {
    if (settleTimerRef.current === null) return;
    window.clearTimeout(settleTimerRef.current);
    settleTimerRef.current = null;
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
    resetPagerSurface(surface);
  }, []);

  const hardReset = useCallback((surface = surfaceRef.current) => {
    transition({ type: 'reset' });
    gestureRef.current = null;
    clearSettleTimer();
    clearClickSuppression();
    clearSurface(surface);
  }, [clearClickSuppression, clearSettleTimer, clearSurface, transition]);

  const settle = useCallback((targetIndex: number | null, offset: number) => {
    const surface = surfaceRef.current;
    if (!surface) return;

    gestureRef.current = null;
    clearSettleTimer();
    const { generation } = transition({ type: 'settle', targetIndex });
    surface.dataset.pagerPhase = 'settling';
    surface.style.setProperty('--pager-offset-x', `${offset}px`);

    const finish = () => {
      const before = transitionRef.current;
      const after = reducePagerTransition(before, { type: 'finish', generation });
      if (after === before) return;

      transitionRef.current = after;
      settleTimerRef.current = null;
      clearSurface(surface);
      if (targetIndex === null) return;
      const targetTab = EMPLOYEE_NAV_TABS[targetIndex];
      if (targetTab) onChangeRef.current(targetTab);
    };

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) finish();
    else settleTimerRef.current = window.setTimeout(finish, TMS_LIMITS.SWIPE_SETTLE_MS);
  }, [clearSettleTimer, clearSurface, transition]);

  const cancelGesture = useCallback(() => {
    const gesture = gestureRef.current;
    gestureRef.current = null;
    clearClickSuppression();
    if (gesture?.axis === 'horizontal') settle(null, 0);
    else hardReset();
  }, [clearClickSuppression, hardReset, settle]);

  useLayoutEffect(() => {
    hardReset();
  }, [activeTab, disabled, hardReset, navigationResetVersion]);

  useEffect(() => {
    const handleInterruption = () => hardReset();
    const handleVisibilityChange = () => {
      if (document.hidden) hardReset();
    };

    window.addEventListener('blur', handleInterruption);
    window.addEventListener('pagehide', handleInterruption);
    window.addEventListener('resize', handleInterruption);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.removeEventListener('blur', handleInterruption);
      window.removeEventListener('pagehide', handleInterruption);
      window.removeEventListener('resize', handleInterruption);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      hardReset();
    };
  }, [hardReset]);

  const onTouchStart = useCallback<TouchEventHandler<HTMLDivElement>>((event) => {
    hardReset(event.currentTarget);
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
  }, [disabled, hardReset]);

  const onTouchMove = useCallback<TouchEventHandler<HTMLDivElement>>((event) => {
    const gesture = gestureRef.current;
    if (!gesture) return;
    if (disabled || event.touches.length !== 1) {
      hardReset(event.currentTarget);
      return;
    }
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
    transition({ type: 'drag' });
    const movementX = current.x - gesture.start.x;
    const direction = movementX < 0 ? 'left' : 'right';
    // The page only follows the finger when the swipe will actually change tab.
    // A swipe that lands on one of the page's own views rubber-bands instead,
    // so the movement never promises a page change it will not make.
    const allowed = resolveSwipeTarget({
      direction,
      tabIndex: activeIndex,
      tabCount: EMPLOYEE_NAV_TABS.length,
      sub: subPagerRef.current.value,
    })?.kind === 'tab';
    const visualOffset = resistedSwipeOffset(movementX, gesture.width, allowed);
    event.currentTarget.dataset.pagerPhase = 'dragging';
    event.currentTarget.style.setProperty('--pager-offset-x', `${visualOffset}px`);
  }, [activeIndex, disabled, hardReset, suppressSyntheticClick, transition]);

  const onTouchEnd = useCallback<TouchEventHandler<HTMLDivElement>>((event) => {
    const gesture = gestureRef.current;
    gestureRef.current = null;
    const touch = event.changedTouches[0];
    if (!gesture || !touch || disabled) {
      hardReset(event.currentTarget);
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

    if (finalAxis !== 'horizontal') {
      hardReset(event.currentTarget);
      return;
    }

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
    const resolution = direction
      ? resolveSwipeTarget({
        direction,
        tabIndex: activeIndex,
        tabCount: EMPLOYEE_NAV_TABS.length,
        sub: subPagerRef.current.value,
      })
      : null;

    event.preventDefault();
    event.stopPropagation();
    if (!resolution) {
      settle(null, 0);
      return;
    }
    if (resolution.kind === 'sub') {
      // The page swaps its own content, so the pager returns to rest rather
      // than sliding a neighbouring tab in.
      subPagerRef.current.value?.select(resolution.index);
      settle(null, 0);
      return;
    }
    settle(resolution.index, direction === 'left' ? -gesture.width : gesture.width);
  }, [activeIndex, disabled, hardReset, settle]);

  const onClickCapture = useCallback<MouseEventHandler<HTMLDivElement>>((event) => {
    if (!suppressClickRef.current) return;
    clearClickSuppression();
    event.preventDefault();
    event.stopPropagation();
  }, [clearClickSuppression]);

  const onScroll = useCallback<UIEventHandler<HTMLDivElement>>((event) => {
    // Recovery path for older WebViews that treat overflow: clip as hidden.
    if (event.currentTarget.scrollLeft !== 0) event.currentTarget.scrollLeft = 0;
  }, []);

  return (
    <div
      ref={surfaceRef}
      className="employee-pager"
      data-active-tab={activeTab}
      onClickCapture={onClickCapture}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={cancelGesture}
      onScroll={onScroll}
    >
      <SubPagerProvider registry={subPagerRef.current}>
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
      </SubPagerProvider>
    </div>
  );
}
