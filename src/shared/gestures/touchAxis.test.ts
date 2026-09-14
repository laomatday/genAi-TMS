import { describe, expect, it } from 'vitest';
import {
  resolveGestureAxis,
  type GesturePoint,
} from './touchAxis';

const options = {
  lockDistancePx: 6,
  dominanceRatio: 1.3,
};

const point = (x: number, y: number, time: number): GesturePoint => ({ x, y, time });

describe('touch axis resolution', () => {
  it('locks to one dominant axis after the dead zone', () => {
    const start = point(200, 300, 0);
    expect(resolveGestureAxis(start, point(194, 305, 20), options)).toBe('pending');
    expect(resolveGestureAxis(start, point(170, 296, 40), options)).toBe('horizontal');
    expect(resolveGestureAxis(start, point(195, 260, 40), options)).toBe('vertical');
  });
});
