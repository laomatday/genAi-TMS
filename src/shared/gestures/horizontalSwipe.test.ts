import { describe, expect, it } from 'vitest';
import {
  detectHorizontalSwipe,
  horizontalSwipeThreshold,
  resolveGestureAxis,
  type GesturePoint,
  type SwipeOptions,
} from './horizontalSwipe';

const options: SwipeOptions = {
  lockDistancePx: 12,
  dominanceRatio: 1.25,
  minDistancePx: 56,
  viewportRatio: 0.16,
  maxDistancePx: 104,
  maxDurationMs: 850,
  minVelocityPxMs: 0.1,
  longSwipeMultiplier: 1.7,
};

const point = (x: number, y: number, time: number): GesturePoint => ({ x, y, time });

describe('horizontal touch gestures', () => {
  it('locks to one dominant axis after the dead zone', () => {
    const start = point(200, 300, 0);
    expect(resolveGestureAxis(start, point(194, 305, 20), options)).toBe('pending');
    expect(resolveGestureAxis(start, point(170, 296, 40), options)).toBe('horizontal');
    expect(resolveGestureAxis(start, point(195, 260, 40), options)).toBe('vertical');
  });

  it('uses a bounded threshold that adapts to the viewport', () => {
    expect(horizontalSwipeThreshold(320, options)).toBe(56);
    expect(horizontalSwipeThreshold(600, options)).toBe(96);
    expect(horizontalSwipeThreshold(1200, options)).toBe(104);
  });

  it('detects deliberate left and right swipes', () => {
    expect(detectHorizontalSwipe(point(300, 200, 0), point(220, 204, 300), 390, options)).toBe('left');
    expect(detectHorizontalSwipe(point(80, 200, 0), point(160, 196, 300), 390, options)).toBe('right');
  });

  it('rejects short, diagonal and slow accidental drags', () => {
    const start = point(300, 200, 0);
    expect(detectHorizontalSwipe(start, point(260, 202, 200), 390, options)).toBeNull();
    expect(detectHorizontalSwipe(start, point(220, 130, 300), 390, options)).toBeNull();
    expect(detectHorizontalSwipe(start, point(230, 198, 1200), 390, options)).toBeNull();
  });

  it('still accepts a long deliberate accessibility swipe', () => {
    expect(detectHorizontalSwipe(point(300, 200, 0), point(180, 198, 1400), 390, options)).toBe('left');
  });
});
