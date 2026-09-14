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
  flingVelocityPxMs: number;
  projectionMs: number;
  longSwipeMultiplier: number;
}

export function recentHorizontalVelocity(
  points: readonly GesturePoint[],
  lookbackMs: number,
) {
  const end = points[points.length - 1];
  if (!end || points.length < 2) return 0;

  const cutoff = end.time - Math.max(1, lookbackMs);
  let start = points[points.length - 2] ?? end;
  for (let index = points.length - 2; index >= 0; index -= 1) {
    const candidate = points[index];
    if (!candidate) continue;
    if (candidate.time < cutoff) break;
    start = candidate;
  }

  return (end.x - start.x) / Math.max(1, end.time - start.time);
}

/**
 * Direct movement is preserved in the available direction. At a boundary the
 * distance is compressed, matching the elastic edge feedback used by native
 * messaging apps without allowing the page to drift away from the finger.
 */
export function resistedSwipeOffset(
  movementX: number,
  viewportWidth: number,
  directionAllowed: boolean,
) {
  const width = Math.max(1, viewportWidth);
  if (!directionAllowed) {
    return Math.sign(movementX) * width * (1 - Math.exp(-Math.abs(movementX) / width)) * 0.28;
  }
  if (Math.abs(movementX) <= width) return movementX;
  const overflow = Math.abs(movementX) - width;
  return Math.sign(movementX) * (width + overflow * 0.12);
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
  releaseVelocityX = 0,
): HorizontalSwipeDirection | null {
  const movementX = end.x - start.x;
  const distanceX = Math.abs(movementX);
  const distanceY = Math.abs(end.y - start.y);
  const threshold = horizontalSwipeThreshold(viewportWidth, options);
  if (distanceX <= distanceY * options.dominanceRatio) return null;

  const duration = Math.max(1, end.time - start.time);
  const averageVelocity = distanceX / duration;
  const projectedDistance = Math.abs(movementX + releaseVelocityX * options.projectionMs);
  const isLongDeliberateSwipe = distanceX >= threshold * options.longSwipeMultiplier;
  const isFling = distanceX >= options.lockDistancePx * 2
    && Math.abs(releaseVelocityX) >= options.flingVelocityPxMs
    && Math.sign(releaseVelocityX) === Math.sign(movementX)
    && projectedDistance >= threshold;
  const crossedDistance = distanceX >= threshold;

  if (!crossedDistance && !isFling) return null;
  if (!isLongDeliberateSwipe && !isFling && (duration > options.maxDurationMs || averageVelocity < options.minVelocityPxMs)) {
    return null;
  }

  return movementX < 0 ? 'left' : 'right';
}

export function shouldIgnoreHorizontalSwipe(target: EventTarget | null, boundary?: HTMLElement | null) {
  if (!(target instanceof Element)) return true;
  const nestedSwipeSurface = target.closest('[data-swipe-surface]');
  if (nestedSwipeSurface && nestedSwipeSurface !== boundary) return true;
  if (target.closest('input, textarea, select, [role="slider"], [contenteditable="true"], [draggable="true"], [data-swipe-ignore="true"]')) {
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
