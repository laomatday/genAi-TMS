export type GestureAxis = 'pending' | 'horizontal' | 'vertical';
export type HorizontalSwipeDirection = 'left' | 'right';

export interface GesturePoint {
  x: number;
  y: number;
  time: number;
}

export interface AxisOptions {
  lockDistancePx: number;
  dominanceRatio: number;
}

export interface SwipeOptions extends AxisOptions {
  minDistancePx: number;
  viewportRatio: number;
  maxDistancePx: number;
  maxDurationMs: number;
  minVelocityPxMs: number;
  longSwipeMultiplier: number;
}

export function resolveGestureAxis(
  start: GesturePoint,
  current: GesturePoint,
  options: AxisOptions,
): GestureAxis {
  const distanceX = Math.abs(current.x - start.x);
  const distanceY = Math.abs(current.y - start.y);
  if (Math.max(distanceX, distanceY) < options.lockDistancePx) return 'pending';
  if (distanceX > distanceY * options.dominanceRatio) return 'horizontal';
  if (distanceY > distanceX * options.dominanceRatio) return 'vertical';
  return 'pending';
}

export function horizontalSwipeThreshold(
  viewportWidth: number,
  options: Pick<SwipeOptions, 'minDistancePx' | 'viewportRatio' | 'maxDistancePx'>,
) {
  const responsiveDistance = Math.max(0, viewportWidth) * options.viewportRatio;
  return Math.min(options.maxDistancePx, Math.max(options.minDistancePx, responsiveDistance));
}

export function detectHorizontalSwipe(
  start: GesturePoint,
  end: GesturePoint,
  viewportWidth: number,
  options: SwipeOptions,
): HorizontalSwipeDirection | null {
  const movementX = end.x - start.x;
  const distanceX = Math.abs(movementX);
  const distanceY = Math.abs(end.y - start.y);
  const threshold = horizontalSwipeThreshold(viewportWidth, options);
  if (distanceX < threshold || distanceX <= distanceY * options.dominanceRatio) return null;

  const duration = Math.max(1, end.time - start.time);
  const velocity = distanceX / duration;
  const isLongDeliberateSwipe = distanceX >= threshold * options.longSwipeMultiplier;
  if (!isLongDeliberateSwipe && (duration > options.maxDurationMs || velocity < options.minVelocityPxMs)) {
    return null;
  }

  return movementX < 0 ? 'left' : 'right';
}

export function shouldIgnoreHorizontalSwipe(target: EventTarget | null, boundary?: HTMLElement | null) {
  if (!(target instanceof Element)) return true;
  if (target.closest('input, textarea, select, button, a, [role="button"], [role="slider"], [contenteditable="true"], [draggable="true"], [data-swipe-ignore="true"]')) {
    return true;
  }

  let element: Element | null = target;
  while (element && element !== boundary && element instanceof HTMLElement) {
    const overflowX = window.getComputedStyle(element).overflowX;
    if ((overflowX === 'auto' || overflowX === 'scroll') && element.scrollWidth > element.clientWidth) {
      return true;
    }
    element = element.parentElement;
  }
  return false;
}
