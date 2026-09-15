import { APP_INFO } from '@/shared/constants';

/** Folds Vietnamese diacritics away and drops anything that is not a plain
 *  letter, digit or space, so a derived password can be typed on any keyboard
 *  layout and survives a copy/paste through a spreadsheet. */
function asciiSlug(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '');
}

/** "Cao Văn Trọng Nghĩa" → "cvtnghia": the initial of every word except the
 *  last, then the last word in full. A single-word name is used unchanged.
 *
 *  Exported for direct unit testing — this decides the credential every new
 *  account is handed, so a silent change here locks out a whole intake. */
export function accountPasswordPrefix(name: string) {
  const words = asciiSlug(name).split(/\s+/).filter(Boolean);
  const lastWord = words[words.length - 1];
  if (!lastWord) return '';
  return `${words.slice(0, -1).map((word) => word.slice(0, 1)).join('')}${lastWord}`;
}

/** The password a newly created account starts with: the employee's name folded
 *  to initials, then the tenant brand — `Cao Văn Trọng Nghĩa` becomes
 *  `cvtnghia@genai`.
 *
 *  The suffix is read from `APP_INFO` rather than written as a literal, so a
 *  white-label deployment keeps its own brand without a code change.
 *
 *  This value is derived from information anyone in the company can see, so it
 *  is guessable by design. It is a first-login credential only: `employees`
 *  carries `password_change_required` until the owner replaces it. */
export function defaultAccountPassword(input: { name: string; employeeId: string; brand?: string }) {
  const suffix = asciiSlug(input.brand ?? APP_INFO.BRAND).replace(/\s+/g, '');
  // A name with no usable letters would collapse to a bare "@brand" — the same
  // password for every such account. Fall back to the employee code instead.
  const prefix = accountPasswordPrefix(input.name) || asciiSlug(input.employeeId).replace(/\s+/g, '');
  return `${prefix}@${suffix}`;
}
