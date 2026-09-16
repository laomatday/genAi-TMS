import { describe, expect, it } from 'vitest';
import { sectionsForRole, validateAccount } from './accountEditor';
import type { EmployeeInput } from './adminService';
import type { AdminData } from './types';

const data = {
  locations: [{ center_id: 'DN01', center_name: 'Đà Nẵng 1' }],
  policies: [
    { id: 'pol-1', name: 'Ca hành chính', active: true },
    { id: 'pol-old', name: 'Ca cũ', active: false },
  ],
} as unknown as AdminData;

function account(overrides: Partial<EmployeeInput> = {}): EmployeeInput {
  return {
    employee_id: 'EMP-1',
    name: 'Trần Minh Khoa',
    email: 'khoa@example.com',
    phone: '',
    role: 'Staff',
    center_id: 'DN01',
    allowed_locations: ['DN01'],
    managed_locations: [],
    direct_manager_id: null,
    annual_leave_balance: 12,
    attendance_policy_id: 'pol-1',
    position: '',
    department: '',
    status: 'Active',
    device_lock_required: null,
    capability_overrides: {},
    password: 'mot-mat-khau',
    ...overrides,
  } as EmployeeInput;
}

describe('validateAccount', () => {
  it('accepts a complete account', () => {
    expect(validateAccount(account(), 'create', false, data)).toBeNull();
  });

  it('points an identity problem at the profile section', () => {
    expect(validateAccount(account({ name: '  ' }), 'create', false, data))
      .toMatchObject({ section: 'profile' });
    expect(validateAccount(account({ email: 'khong-phai-email' }), 'create', false, data))
      .toMatchObject({ section: 'profile' });
    expect(validateAccount(account({ employee_id: 'A' }), 'create', false, data))
      .toMatchObject({ section: 'profile' });
  });

  it('points a posting problem at the work section', () => {
    // This is the case that drove the split: the message used to appear at the
    // top of the form while the field itself was far down a different part.
    expect(validateAccount(account({ attendance_policy_id: 'pol-old' }), 'create', false, data))
      .toMatchObject({ section: 'work' });
    expect(validateAccount(account({ center_id: 'KHONG-CO' }), 'create', false, data))
      .toMatchObject({ section: 'work' });
    expect(validateAccount(account({ direct_manager_id: 'EMP-1' }), 'create', false, data))
      .toMatchObject({ section: 'work' });
    expect(validateAccount(account({ annual_leave_balance: -1 }), 'create', false, data))
      .toMatchObject({ section: 'work' });
  });

  it('points a credential problem at the access section', () => {
    expect(validateAccount(account({ password: 'ngan' }), 'create', false, data))
      .toMatchObject({ section: 'access' });
  });

  it('lets a Kiosk skip the attendance policy', () => {
    expect(validateAccount(account({ role: 'Kiosk', attendance_policy_id: null }), 'create', false, data)).toBeNull();
  });

  it('asks for a password only when the account needs one', () => {
    // An existing sign-in being edited does not have to supply a new password.
    expect(validateAccount(account({ password: '' }), 'update', true, data)).toBeNull();
    // A profile with no sign-in yet, being activated, does.
    expect(validateAccount(account({ password: '' }), 'update', false, data))
      .toMatchObject({ section: 'access' });
    // Unless it is being left inactive.
    expect(validateAccount(account({ password: '', status: 'Inactive' }), 'update', false, data)).toBeNull();
  });

  it('rejects a location that no longer exists', () => {
    expect(validateAccount(account({ managed_locations: ['DA-XOA'] }), 'create', false, data))
      .toMatchObject({ section: 'work' });
  });
});

describe('sectionsForRole', () => {
  it('drops the permission section for a Kiosk, which has no person behind it', () => {
    expect(sectionsForRole('Kiosk').map((section) => section.id)).toEqual(['profile', 'work', 'access']);
  });

  it('keeps every section for a person', () => {
    expect(sectionsForRole('Staff').map((section) => section.id))
      .toEqual(['profile', 'work', 'access', 'capabilities']);
  });
});
