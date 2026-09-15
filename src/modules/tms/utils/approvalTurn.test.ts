import { describe, expect, it } from 'vitest';
import { canOverrideReview, isOverrideReasonValid, isReviewerTurn } from './approvalTurn';

describe('isReviewerTurn', () => {
  it('lets the assigned reviewer decide', () => {
    expect(isReviewerTurn({ assigned_to: 'ANB-07' }, 'ANB-07')).toBe(true);
  });

  it('blocks a reviewer who already cleared an earlier step', () => {
    // REQ-000005 in production: the direct manager approved step 1, so the
    // request moved to HR. It stays in the manager's role-scoped queue, but
    // pressing approve there is rejected by the database.
    expect(isReviewerTurn({ assigned_to: 'ANB-07' }, 'ADMIN001')).toBe(false);
  });

  it('falls through to the server when no step owner is recorded', () => {
    expect(isReviewerTurn({ assigned_to: null }, 'ADMIN001')).toBe(true);
    expect(isReviewerTurn({}, 'ADMIN001')).toBe(true);
  });

  it('ignores stray whitespace on either side', () => {
    expect(isReviewerTurn({ assigned_to: ' ADMIN001 ' }, 'ADMIN001')).toBe(true);
    expect(isReviewerTurn({ assigned_to: '  ' }, 'ADMIN001')).toBe(true);
  });
});

describe('canOverrideReview', () => {
  it('recognises the capability HR and Admin carry', () => {
    expect(canOverrideReview(['attendance.review', 'attendance.review.override'])).toBe(true);
  });

  it('refuses a reviewer who can only handle their own steps', () => {
    expect(canOverrideReview(['attendance.review'])).toBe(false);
    expect(canOverrideReview([])).toBe(false);
  });
});

describe('isOverrideReasonValid', () => {
  it('demands the reason length the database enforces', () => {
    expect(isOverrideReasonValid('HR nghỉ phép')).toBe(true);
    expect(isOverrideReasonValid('ok')).toBe(false);
  });

  it('does not count surrounding whitespace toward the minimum', () => {
    expect(isOverrideReasonValid('        ')).toBe(false);
  });
});
