import { describe, expect, it, vi } from 'vitest';
import { TMS_LIMITS } from '@/shared/constants';
import type { EmployeeInput } from './adminService';
import {
  EmployeeImportError,
  assertEmployeeImportRowCount,
  executeEmployeeImport,
  type EmployeeImportRow,
} from './adminExcel';

function importRow(employeeId: string, rowNumber: number): EmployeeImportRow {
  const employee: EmployeeInput = {
    employee_id: employeeId,
    name: `Nhân viên ${employeeId}`,
    email: `${employeeId.toLowerCase()}@example.com`,
    role: 'Staff',
    center_id: 'HCM01',
    attendance_policy_id: 'policy-default',
    status: 'Active',
    password: 'Commercial!123',
  };
  return { mode: 'create', rowNumber, employee };
}

describe('employee Excel import resilience', () => {
  it('uses reconciliation upsert and records only confirmed rows', async () => {
    const rows = [importRow('EMP001', 2), importRow('EMP002', 3)];
    rows[1] = { ...rows[1]!, mode: 'update' };
    const write = vi.fn().mockResolvedValue({ ok: true });

    await expect(executeEmployeeImport(rows, write)).resolves.toEqual({
      total: 2,
      confirmed: 2,
      employeeIds: ['EMP001', 'EMP002'],
    });
    expect(write).toHaveBeenNthCalledWith(1, rows[0]?.employee, 'upsert', { expectedMode: 'create' });
    expect(write).toHaveBeenNthCalledWith(2, rows[1]?.employee, 'upsert', { expectedMode: 'update' });
  });

  it('reports confirmed, uncertain and unsubmitted work after an interrupted response', async () => {
    const rows = [importRow('EMP001', 2), importRow('EMP002', 3), importRow('EMP003', 4)];
    const uncertain = Object.assign(new Error('Failed to send a request'), { outcome: 'unknown' as const });
    const write = vi.fn()
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(uncertain);

    const failure = await executeEmployeeImport(rows, write).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(EmployeeImportError);
    expect(failure).toMatchObject({
      total: 3,
      confirmed: 1,
      failedRowNumber: 3,
      failedEmployeeId: 'EMP002',
      remaining: 2,
      failureState: 'unknown',
    });
    expect((failure as Error).message).toContain('Kết quả dòng này chưa xác định');
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('can safely retry the same rows without switching back to create mode', async () => {
    const rows = [importRow('EMP001', 2), importRow('EMP002', 3)];
    const firstAttempt = vi.fn()
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(Object.assign(new Error('Gateway timeout'), { outcome: 'partial' as const }));
    await expect(executeEmployeeImport(rows, firstAttempt)).rejects.toMatchObject({
      confirmed: 1,
      failureState: 'partial',
    });

    const retry = vi.fn().mockResolvedValue({ ok: true });
    await expect(executeEmployeeImport(rows, retry)).resolves.toMatchObject({ confirmed: 2 });
    expect(retry.mock.calls.map((call) => call[1])).toEqual(['upsert', 'upsert']);
  });

  it('caps interactive account imports to a bounded reconciliation surface', () => {
    expect(() => assertEmployeeImportRowCount(1)).not.toThrow();
    expect(() => assertEmployeeImportRowCount(TMS_LIMITS.MAX_EMPLOYEE_IMPORT_ROWS)).not.toThrow();
    expect(() => assertEmployeeImportRowCount(0)).toThrow(/từ 1/);
    expect(() => assertEmployeeImportRowCount(TMS_LIMITS.MAX_EMPLOYEE_IMPORT_ROWS + 1)).toThrow(/100/);
  });
});
