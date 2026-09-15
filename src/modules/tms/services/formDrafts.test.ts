import { describe, expect, it } from 'vitest';
import { createFormDraft, FORM_DRAFT_TTL_MS, validateFormDraft } from './formDrafts';

const user = { organization_id: 'tenant-a', employee_id: 'EMP-001' };
const commandId = '40000000-0000-4000-8000-000000000001';
const now = new Date('2026-09-15T08:00:00Z');

describe('form drafts', () => {
  it('persists the idempotency key with a tenant-scoped versioned draft', () => {
    const draft = createFormDraft(user, 'request', 'default', commandId, { reason: 'Đi công tác' }, now);
    expect(draft).toMatchObject({
      schemaVersion: 1,
      organizationId: 'tenant-a',
      employeeId: 'EMP-001',
      clientRequestId: commandId,
      value: { reason: 'Đi công tác' },
    });
    expect(validateFormDraft(draft, user, 'request', 'default', now)).toEqual(draft);
  });

  it('rejects expired or cross-tenant drafts', () => {
    const draft = createFormDraft(user, 'explanation', '2026-09-14', commandId, { reason: 'Quên check-out' }, now);
    expect(validateFormDraft(draft, { ...user, organization_id: 'tenant-b' }, 'explanation', '2026-09-14', now)).toBeNull();
    expect(validateFormDraft(draft, user, 'explanation', '2026-09-14', new Date(now.getTime() + FORM_DRAFT_TTL_MS + 1))).toBeNull();
  });

  it('does not create an unscoped or malformed command draft', () => {
    expect(createFormDraft({ employee_id: 'EMP-001' }, 'request', 'default', commandId, {}, now)).toBeNull();
    expect(createFormDraft(user, 'request', 'default', 'not-a-uuid', {}, now)).toBeNull();
  });
});
