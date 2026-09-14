import { describe, expect, it } from 'vitest';
import {
  detectHorizontalSwipe,
  horizontalSwipeThreshold,
  recentHorizontalVelocity,
  resistedSwipeOffset,
  resolveGestureAxis,
  type GesturePoint,
  type SwipeOptions,
} from './horizontalSwipe';

const options: SwipeOptions = {
  lockDistancePx: 6,
  dominanceRatio: 1.3,
  minDistancePx: 44,
  viewportRatio: 0.12,
  maxDistancePx: 88,
  maxDurationMs: 850,
  minVelocityPxMs: 0.07,
  flingVelocityPxMs: 0.32,
  projectionMs: 180,
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
    expect(horizontalSwipeThreshold(320, options)).toBe(44);
    expect(horizontalSwipeThreshold(600, options)).toBe(72);
    expect(horizontalSwipeThreshold(1200, options)).toBe(88);
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

  it('uses recent release velocity to accept a short intentional flick', () => {
    const start = point(300, 200, 0);
    const end = point(260, 202, 120);
    expect(detectHorizontalSwipe(start, end, 390, options, -0.8)).toBe('left');
    expect(detectHorizontalSwipe(start, end, 390, options, -0.2)).toBeNull();
    expect(detectHorizontalSwipe(start, end, 390, options, 0.8)).toBeNull();
  });
});

describe('native-feeling swipe feedback', () => {
  it('calculates velocity from the latest movement window', () => {
    expect(recentHorizontalVelocity([
      point(300, 200, 0),
      point(295, 200, 300),
      point(255, 200, 350),
    ], 100)).toBeCloseTo(-0.8);
  });

  it('preserves direct tracking and adds resistance at a blocked edge', () => {
    expect(resistedSwipeOffset(80, 400, true)).toBe(80);
    expect(resistedSwipeOffset(80, 400, false)).toBeGreaterThan(0);
    expect(resistedSwipeOffset(80, 400, false)).toBeLessThan(25);
  });
});
