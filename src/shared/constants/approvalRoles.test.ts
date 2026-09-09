import { describe, expect, it } from 'vitest';
import { canApprove, canApproveAny, DEFAULT_APPROVAL_ROLES, normalizeApprovalRoles } from './index';

describe('normalizeApprovalRoles', () => {
  it('defaults to Manager/Director/HR/Admin, no Leader', () => {
    const config = normalizeApprovalRoles(null);
    expect(config.leave.sort()).toEqual(['Admin', 'Director', 'HR', 'Manager']);
    expect(config.attendance).not.toContain('Leader');
  });

  it('parses a stored JSON string and always keeps Admin', () => {
    const config = normalizeApprovalRoles(JSON.stringify({ leave: ['Manager'], attendance: [] }));
    expect(config.leave.sort()).toEqual(['Admin', 'Manager']);
    expect(config.attendance).toEqual(['Admin']);
  });

  it('drops non-editable / unknown roles', () => {
    const config = normalizeApprovalRoles({ leave: ['Leader', 'Staff', 'Kiosk', 'bogus'], attendance: ['Leader'] });
    expect(config.leave.sort()).toEqual(['Admin', 'Leader']);
    expect(config.attendance.sort()).toEqual(['Admin', 'Leader']);
  });

  it('falls back to defaults for malformed input', () => {
    expect(normalizeApprovalRoles('{not json').leave.sort()).toEqual(['Admin', 'Director', 'HR', 'Manager']);
  });
});

describe('canApprove', () => {
  it('Leader cannot approve either kind by default', () => {
    expect(canApprove('Leader', 'leave', DEFAULT_APPROVAL_ROLES)).toBe(false);
    expect(canApprove('Leader', 'attendance', DEFAULT_APPROVAL_ROLES)).toBe(false);
    expect(canApproveAny('Leader', DEFAULT_APPROVAL_ROLES)).toBe(false);
  });

  it('Manager and Admin can approve by default', () => {
    expect(canApprove('Manager', 'leave', DEFAULT_APPROVAL_ROLES)).toBe(true);
    expect(canApproveAny('Admin', DEFAULT_APPROVAL_ROLES)).toBe(true);
  });

  it('respects a config that only grants one kind', () => {
    const config = normalizeApprovalRoles({ leave: ['Leader'], attendance: [] });
    expect(canApprove('Leader', 'leave', config)).toBe(true);
    expect(canApprove('Leader', 'attendance', config)).toBe(false);
    expect(canApproveAny('Leader', config)).toBe(true);
  });
});
