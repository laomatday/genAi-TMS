import { useCallback, useEffect, useRef, type MouseEventHandler, type TouchEventHandler } from 'react';
import { TMS_LIMITS } from '@/shared/constants';
import {
  detectHorizontalSwipe,
  recentHorizontalVelocity,
  resistedSwipeOffset,
  resolveGestureAxis,
  shouldIgnoreHorizontalSwipe,
  type GestureAxis,
  type GesturePoint,
  type HorizontalSwipeDirection,
} from '@/shared/gestures/horizontalSwipe';

interface HorizontalSwipeOptions {
  onSwipe: (direction: HorizontalSwipeDirection) => boolean | void;
  disabled?: boolean;
  minDistancePx?: number;
  viewportRatio?: number;
  shouldStart?: (target: EventTarget | null, boundary: HTMLElement) => boolean;
  canSwipe?: (direction: HorizontalSwipeDirection) => boolean;
  completeBeforeSwipe?: boolean;
}

interface ActiveGesture {
  start: GesturePoint;
  last: GesturePoint;
  samples: GesturePoint[];
  axis: GestureAxis;
  boundary: HTMLElement;
  width: number;
}

export interface HorizontalSwipeHandlers {
  onClickCapture: MouseEventHandler<HTMLElement>;
  onTouchStart: TouchEventHandler<HTMLElement>;
  onTouchMove: TouchEventHandler<HTMLElement>;
  onTouchEnd: TouchEventHandler<HTMLElement>;
  onTouchCancel: TouchEventHandler<HTMLElement>;
}

const pointFromTouch = (touch: { clientX: number; clientY: number }, time: number): GesturePoint => ({
  x: touch.clientX,
  y: touch.clientY,
  time,
});

export function useHorizontalSwipe({
  onSwipe,
  disabled = false,
  minDistancePx = TMS_LIMITS.SWIPE_NAVIGATION_PX,
  viewportRatio = TMS_LIMITS.SWIPE_NAVIGATION_VIEWPORT_RATIO,
  shouldStart,
  canSwipe,
  completeBeforeSwipe = false,
}: HorizontalSwipeOptions): HorizontalSwipeHandlers {
  const gestureRef = useRef<ActiveGesture | null>(null);
  const onSwipeRef = useRef(onSwipe);
  const shouldStartRef = useRef(shouldStart);
  const canSwipeRef = useRef(canSwipe);
  const finishTimerRef = useRef<number | null>(null);
  const clickSuppressionTimerRef = useRef<number | null>(null);
  const suppressClickRef = useRef(false);
  onSwipeRef.current = onSwipe;
  shouldStartRef.current = shouldStart;
  canSwipeRef.current = canSwipe;

  const clearFinishTimer = useCallback(() => {
    if (finishTimerRef.current !== null) {
      window.clearTimeout(finishTimerRef.current);
      finishTimerRef.current = null;
    }
  }, []);

  const clearClickSuppression = useCallback(() => {
    if (clickSuppressionTimerRef.current !== null) {
      window.clearTimeout(clickSuppressionTimerRef.current);
      clickSuppressionTimerRef.current = null;
    }
    suppressClickRef.current = false;
  }, []);

  const clearSurface = useCallback((surface?: HTMLElement | null) => {
    if (!surface) return;
    surface.style.removeProperty('--swipe-offset-x');
    delete surface.dataset.swipePhase;
  }, []);

  const reset = useCallback(() => {
    const surface = gestureRef.current?.boundary;
    gestureRef.current = null;
    if (surface) {
      surface.dataset.swipePhase = 'settling';
      surface.style.setProperty('--swipe-offset-x', '0px');
      clearFinishTimer();
      finishTimerRef.current = window.setTimeout(() => {
        clearSurface(surface);
        finishTimerRef.current = null;
      }, TMS_LIMITS.SWIPE_SETTLE_MS);
    }
  }, [clearFinishTimer, clearSurface]);

  useEffect(() => () => {
    clearFinishTimer();
    clearClickSuppression();
    clearSurface(gestureRef.current?.boundary);
  }, [clearClickSuppression, clearFinishTimer, clearSurface]);

  const onTouchStart = useCallback<TouchEventHandler<HTMLElement>>((event) => {
    if (disabled || event.touches.length !== 1) {
      reset();
      return;
    }
    const touch = event.touches[0];
    if (!touch) return;
    const boundary = event.currentTarget;
    const canStart = shouldStartRef.current
      ? shouldStartRef.current(event.target, boundary)
      : !shouldIgnoreHorizontalSwipe(event.target, boundary);
    if (!canStart) {
      reset();
      return;
    }
    const start = pointFromTouch(touch, event.timeStamp);
    clearFinishTimer();
    clearClickSuppression();
    clearSurface(boundary);
    gestureRef.current = {
      start,
      last: start,
      samples: [start],
      axis: 'pending',
      boundary,
      width: boundary.clientWidth || window.innerWidth,
    };
  }, [clearClickSuppression, clearFinishTimer, clearSurface, disabled, reset]);

  const onTouchMove = useCallback<TouchEventHandler<HTMLElement>>((event) => {
    const gesture = gestureRef.current;
    if (!gesture) return;
    if (disabled || event.touches.length !== 1) {
      reset();
      return;
    }
    const touch = event.touches[0];
    if (!touch) return;
    gesture.last = pointFromTouch(touch, event.timeStamp);
    gesture.samples.push(gesture.last);
    const sampleCutoff = gesture.last.time - TMS_LIMITS.SWIPE_VELOCITY_LOOKBACK_MS * 2;
    while (gesture.samples.length > 2 && (gesture.samples[1]?.time ?? Infinity) < sampleCutoff) {
      gesture.samples.shift();
    }
    if (gesture.axis === 'pending') {
      gesture.axis = resolveGestureAxis(gesture.start, gesture.last, {
        lockDistancePx: TMS_LIMITS.TOUCH_AXIS_LOCK_PX,
        dominanceRatio: TMS_LIMITS.TOUCH_AXIS_DOMINANCE_RATIO,
      });
    }
    if (gesture.axis === 'horizontal') {
      event.preventDefault();
      event.stopPropagation();
      suppressClickRef.current = true;
      if (clickSuppressionTimerRef.current !== null) window.clearTimeout(clickSuppressionTimerRef.current);
      clickSuppressionTimerRef.current = window.setTimeout(
        clearClickSuppression,
        TMS_LIMITS.SWIPE_CLICK_SUPPRESSION_MS,
      );
      const movementX = gesture.last.x - gesture.start.x;
      const direction: HorizontalSwipeDirection = movementX < 0 ? 'left' : 'right';
      const allowed = canSwipeRef.current?.(direction) ?? true;
      const visualOffset = resistedSwipeOffset(movementX, gesture.width, allowed);
      gesture.boundary.dataset.swipePhase = 'dragging';
      gesture.boundary.style.setProperty('--swipe-offset-x', `${visualOffset}px`);
    }
  }, [clearClickSuppression, disabled, reset]);

  const onTouchEnd = useCallback<TouchEventHandler<HTMLElement>>((event) => {
    const gesture = gestureRef.current;
    const changedTouch = event.changedTouches[0];
    gestureRef.current = null;
    if (!gesture || !changedTouch || disabled) {
      if (gesture) gestureRef.current = gesture;
      reset();
      return;
    }

    const end = pointFromTouch(changedTouch, event.timeStamp);
    gesture.samples.push(end);
    const finalAxis = gesture.axis === 'pending'
      ? resolveGestureAxis(gesture.start, end, {
        lockDistancePx: TMS_LIMITS.TOUCH_AXIS_LOCK_PX,
        dominanceRatio: TMS_LIMITS.TOUCH_AXIS_DOMINANCE_RATIO,
      })
      : gesture.axis;
    if (finalAxis !== 'horizontal') return;
    const direction = detectHorizontalSwipe(
      gesture.start,
      end,
      event.currentTarget.clientWidth || window.innerWidth,
      {
        lockDistancePx: TMS_LIMITS.TOUCH_AXIS_LOCK_PX,
        dominanceRatio: TMS_LIMITS.TOUCH_AXIS_DOMINANCE_RATIO,
        minDistancePx,
        viewportRatio,
        maxDistancePx: TMS_LIMITS.SWIPE_MAX_THRESHOLD_PX,
        maxDurationMs: TMS_LIMITS.SWIPE_MAX_DURATION_MS,
        minVelocityPxMs: TMS_LIMITS.SWIPE_MIN_VELOCITY_PX_MS,
        flingVelocityPxMs: TMS_LIMITS.SWIPE_FLING_VELOCITY_PX_MS,
        projectionMs: TMS_LIMITS.SWIPE_PROJECTION_MS,
        longSwipeMultiplier: TMS_LIMITS.SWIPE_LONG_DISTANCE_MULTIPLIER,
      },
      recentHorizontalVelocity(gesture.samples, TMS_LIMITS.SWIPE_VELOCITY_LOOKBACK_MS),
    );
    if (!direction || canSwipeRef.current?.(direction) === false) {
      gestureRef.current = gesture;
      reset();
      return;
    }
    event.preventDefault();
    event.stopPropagation();

    if (completeBeforeSwipe && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      clearFinishTimer();
      gesture.boundary.dataset.swipePhase = 'committing';
      const dismissOffset = direction === 'left' ? -gesture.width : gesture.width;
      gesture.boundary.style.setProperty('--swipe-offset-x', `${dismissOffset}px`);
      finishTimerRef.current = window.setTimeout(() => {
        finishTimerRef.current = null;
        onSwipeRef.current(direction);
        clearSurface(gesture.boundary);
      }, TMS_LIMITS.SWIPE_COMMIT_MS);
      return;
    }

    const accepted = onSwipeRef.current(direction) !== false;
    gestureRef.current = gesture;
    reset();
    if (!accepted) return;
  }, [clearFinishTimer, clearSurface, completeBeforeSwipe, disabled, minDistancePx, reset, viewportRatio]);

  const onClickCapture = useCallback<MouseEventHandler<HTMLElement>>((event) => {
    if (!suppressClickRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    clearClickSuppression();
  }, [clearClickSuppression]);

  return { onClickCapture, onTouchStart, onTouchMove, onTouchEnd, onTouchCancel: reset };
}
