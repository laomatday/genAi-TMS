import { describe, expect, it } from 'vitest';
import { displayRequestCode } from './requestCode';

describe('displayRequestCode', () => {
  it('formats a tenant-issued business reference', () => {
    expect(displayRequestCode({ request_code: 'req-000142' })).toBe('#REQ-000142');
  });

  it('does not expose UUID fragments as business references', () => {
    expect(displayRequestCode({})).toBeNull();
    expect(displayRequestCode({ request_code: 'ca0a55b8-3bb1-4a29-91ce-76cd71bc' })).toBeNull();
    expect(displayRequestCode({ request_code: '76CD71BC' })).toBeNull();
  });
});
