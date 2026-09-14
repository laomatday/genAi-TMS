export type GestureAxis = 'pending' | 'horizontal' | 'vertical';

export interface GesturePoint {
  x: number;
  y: number;
  time: number;
}

export interface AxisOptions {
  lockDistancePx: number;
  dominanceRatio: number;
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

export function shouldIgnorePullGesture(target: EventTarget | null, boundary?: HTMLElement | null) {
  if (!(target instanceof Element)) return true;
  if (target.closest('input, textarea, select, [role="slider"], [contenteditable="true"], [draggable="true"]')) {
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
