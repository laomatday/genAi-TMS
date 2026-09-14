import { describe, expect, it } from 'vitest';
import { adjacentPagerIndex } from './EmployeePager';

describe('employee pager boundaries', () => {
  it('moves by exactly one tab', () => {
    expect(adjacentPagerIndex(2, 'left', 5)).toBe(3);
    expect(adjacentPagerIndex(2, 'right', 5)).toBe(1);
  });

  it('stays inside the bottom-navigation strip', () => {
    expect(adjacentPagerIndex(0, 'right', 5)).toBeNull();
    expect(adjacentPagerIndex(4, 'left', 5)).toBeNull();
  });
});
