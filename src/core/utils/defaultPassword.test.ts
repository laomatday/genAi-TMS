import { describe, expect, it } from 'vitest';
import { accountPasswordPrefix, defaultAccountPassword } from './defaultPassword';

const brand = 'genAi';

describe('accountPasswordPrefix', () => {
  it('keeps the last word and reduces every earlier word to its initial', () => {
    expect(accountPasswordPrefix('Cao Văn Trọng Nghĩa')).toBe('cvtnghia');
    expect(accountPasswordPrefix('Nguyễn Thị Hương')).toBe('nthuong');
  });

  it('uses a single word name unchanged', () => {
    expect(accountPasswordPrefix('Nghĩa')).toBe('nghia');
  });

  it('folds the letter đ, which carries no combining mark', () => {
    expect(accountPasswordPrefix('Trần Đức Đạt')).toBe('tddat');
  });

  it('ignores stray spacing and punctuation', () => {
    expect(accountPasswordPrefix('  Cao   Văn  Trọng   Nghĩa  ')).toBe('cvtnghia');
    expect(accountPasswordPrefix("Trần Lê (Anh) Tú")).toBe('tlatu');
  });

  it('returns nothing when the name has no usable letters', () => {
    expect(accountPasswordPrefix('')).toBe('');
    expect(accountPasswordPrefix('--- ???')).toBe('');
  });
});

describe('defaultAccountPassword', () => {
  it('builds the documented default for a full Vietnamese name', () => {
    expect(defaultAccountPassword({ name: 'Cao Văn Trọng Nghĩa', employeeId: 'EMP001', brand }))
      .toBe('cvtnghia@genai');
  });

  it('takes the suffix from the tenant brand instead of a literal', () => {
    expect(defaultAccountPassword({ name: 'Cao Văn Trọng Nghĩa', employeeId: 'EMP001', brand: 'Acme Corp' }))
      .toBe('cvtnghia@acmecorp');
  });

  // A bare "@brand" would hand every such account the same password.
  it('falls back to the employee code when the name yields no letters', () => {
    expect(defaultAccountPassword({ name: '???', employeeId: 'EMP-001', brand }))
      .toBe('emp001@genai');
  });

  it('stays at or above the eight character account minimum for real names', () => {
    for (const name of ['Cao Văn Trọng Nghĩa', 'Lê An', 'Nghĩa', 'Vũ Hà']) {
      expect(defaultAccountPassword({ name, employeeId: 'EMP001', brand }).length)
        .toBeGreaterThanOrEqual(8);
    }
  });
});
