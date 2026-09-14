import { useCallback, useRef, type TouchEventHandler } from 'react';
import { TMS_LIMITS } from '@/shared/constants';
import {
  detectHorizontalSwipe,
  resolveGestureAxis,
  shouldIgnoreHorizontalSwipe,
  type GestureAxis,
  type GesturePoint,
  type HorizontalSwipeDirection,
} from '@/shared/gestures/horizontalSwipe';

interface HorizontalSwipeOptions {
  onSwipe: (direction: HorizontalSwipeDirection) => void;
  disabled?: boolean;
  minDistancePx?: number;
  viewportRatio?: number;
  shouldStart?: (target: EventTarget | null, boundary: HTMLElement) => boolean;
}

interface ActiveGesture {
  start: GesturePoint;
  last: GesturePoint;
  axis: GestureAxis;
}

export interface HorizontalSwipeHandlers {
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
}: HorizontalSwipeOptions): HorizontalSwipeHandlers {
  const gestureRef = useRef<ActiveGesture | null>(null);
  const onSwipeRef = useRef(onSwipe);
  const shouldStartRef = useRef(shouldStart);
  onSwipeRef.current = onSwipe;
  shouldStartRef.current = shouldStart;

  const reset = useCallback(() => {
    gestureRef.current = null;
  }, []);

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
    gestureRef.current = { start, last: start, axis: 'pending' };
  }, [disabled, reset]);

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
    if (gesture.axis === 'pending') {
      gesture.axis = resolveGestureAxis(gesture.start, gesture.last, {
        lockDistancePx: TMS_LIMITS.TOUCH_AXIS_LOCK_PX,
        dominanceRatio: TMS_LIMITS.TOUCH_AXIS_DOMINANCE_RATIO,
      });
    }
    if (gesture.axis === 'horizontal') {
      event.preventDefault();
      event.stopPropagation();
    }
  }, [disabled, reset]);

  const onTouchEnd = useCallback<TouchEventHandler<HTMLElement>>((event) => {
    const gesture = gestureRef.current;
    const changedTouch = event.changedTouches[0];
    reset();
    if (!gesture || !changedTouch || disabled) return;

    const end = pointFromTouch(changedTouch, event.timeStamp);
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
        longSwipeMultiplier: TMS_LIMITS.SWIPE_LONG_DISTANCE_MULTIPLIER,
      },
    );
    if (!direction) return;
    event.preventDefault();
    event.stopPropagation();
    onSwipeRef.current(direction);
  }, [disabled, minDistancePx, reset, viewportRatio]);

  return { onTouchStart, onTouchMove, onTouchEnd, onTouchCancel: reset };
}
