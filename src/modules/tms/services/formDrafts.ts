import type { Employee } from '@/shared/types';
import { readClientState, removeClientState, writeClientState } from '@/shared/storage/clientPersistence';

const FORM_DRAFT_SCHEMA_VERSION = 1;
export const FORM_DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

export type FormDraftKind = 'request' | 'explanation';

export interface FormDraftRecord<T = unknown> {
  schemaVersion: typeof FORM_DRAFT_SCHEMA_VERSION;
  organizationId: string;
  employeeId: string;
  kind: FormDraftKind;
  scope: string;
  clientRequestId: string;
  updatedAt: string;
  expiresAt: string;
  value: T;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function identityOf(user: Pick<Employee, 'employee_id' | 'organization_id'>) {
  const organizationId = user.organization_id?.trim();
  const employeeId = user.employee_id.trim();
  if (!organizationId || !employeeId) return null;
  return { organizationId, employeeId };
}

function draftKey(
  user: Pick<Employee, 'employee_id' | 'organization_id'>,
  kind: FormDraftKind,
  scope: string,
) {
  const identity = identityOf(user);
  if (!identity) return null;
  return `draft:${encodeURIComponent(identity.organizationId)}:${encodeURIComponent(identity.employeeId)}:${kind}:${encodeURIComponent(scope)}`;
}

export function createFormDraft<T>(
  user: Pick<Employee, 'employee_id' | 'organization_id'>,
  kind: FormDraftKind,
  scope: string,
  clientRequestId: string,
  value: T,
  updatedAt = new Date(),
): FormDraftRecord<T> | null {
  const identity = identityOf(user);
  if (!identity || !scope || !UUID_PATTERN.test(clientRequestId) || Number.isNaN(updatedAt.getTime())) return null;
  return {
    schemaVersion: FORM_DRAFT_SCHEMA_VERSION,
    ...identity,
    kind,
    scope,
    clientRequestId,
    updatedAt: updatedAt.toISOString(),
    expiresAt: new Date(updatedAt.getTime() + FORM_DRAFT_TTL_MS).toISOString(),
    value,
  };
}

export function validateFormDraft<T>(
  value: unknown,
  user: Pick<Employee, 'employee_id' | 'organization_id'>,
  kind: FormDraftKind,
  scope: string,
  now = new Date(),
): FormDraftRecord<T> | null {
  const identity = identityOf(user);
  if (!identity || !value || typeof value !== 'object') return null;
  const draft = value as Partial<FormDraftRecord<T>>;
  if (
    draft.schemaVersion !== FORM_DRAFT_SCHEMA_VERSION
    || draft.organizationId !== identity.organizationId
    || draft.employeeId !== identity.employeeId
    || draft.kind !== kind
    || draft.scope !== scope
    || typeof draft.clientRequestId !== 'string'
    || !UUID_PATTERN.test(draft.clientRequestId)
    || typeof draft.updatedAt !== 'string'
    || typeof draft.expiresAt !== 'string'
    || !draft.value
    || typeof draft.value !== 'object'
  ) return null;
  const updatedAt = Date.parse(draft.updatedAt);
  const expiresAt = Date.parse(draft.expiresAt);
  if (
    !Number.isFinite(updatedAt)
    || !Number.isFinite(expiresAt)
    || expiresAt - updatedAt !== FORM_DRAFT_TTL_MS
    || updatedAt > now.getTime()
    || expiresAt <= now.getTime()
  ) return null;
  return draft as FormDraftRecord<T>;
}

export async function loadFormDraft<T>(
  user: Pick<Employee, 'employee_id' | 'organization_id'>,
  kind: FormDraftKind,
  scope: string,
  now = new Date(),
) {
  const key = draftKey(user, kind, scope);
  if (!key) return null;
  const stored = await readClientState<unknown>(key);
  const draft = validateFormDraft<T>(stored, user, kind, scope, now);
  if (!draft && stored) await removeClientState(key);
  return draft;
}

export async function saveFormDraft<T>(
  user: Pick<Employee, 'employee_id' | 'organization_id'>,
  kind: FormDraftKind,
  scope: string,
  clientRequestId: string,
  value: T,
) {
  const key = draftKey(user, kind, scope);
  const draft = createFormDraft(user, kind, scope, clientRequestId, value);
  if (key && draft) await writeClientState(key, draft);
}

export async function removeFormDraft(
  user: Pick<Employee, 'employee_id' | 'organization_id'>,
  kind: FormDraftKind,
  scope: string,
) {
  const key = draftKey(user, kind, scope);
  if (key) await removeClientState(key);
}
