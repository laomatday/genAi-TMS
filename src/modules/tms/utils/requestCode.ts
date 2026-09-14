interface RequestCodeSource {
  request_code?: string | null;
}

const REQUEST_CODE_PATTERN = /^REQ-[A-Z0-9-]{4,24}$/;

/**
 * Returns the tenant-issued business reference shown to employees and reviewers.
 * Database UUIDs are deliberately never shortened into a user-facing code.
 */
export function displayRequestCode(item: RequestCodeSource): string | null {
  const code = item.request_code?.trim().toUpperCase();
  return code && REQUEST_CODE_PATTERN.test(code) ? `#${code}` : null;
}
