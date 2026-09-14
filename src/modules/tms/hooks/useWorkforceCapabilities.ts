import { useCallback, useEffect, useState } from 'react';
import type { Employee } from '@/shared/types';
import { getEffectiveWorkforceCapabilities } from '@/modules/tms/services/workforceCapabilities';

interface CapabilityState {
  subject: string;
  capabilities: string[];
  loading: boolean;
  loaded: boolean;
  error: string | null;
}

const EMPTY_STATE: CapabilityState = {
  subject: '',
  capabilities: [],
  loading: false,
  loaded: false,
  error: null,
};

export function useWorkforceCapabilities(user: Employee | null, enabled: boolean) {
  const [state, setState] = useState<CapabilityState>(EMPTY_STATE);
  const [revision, setRevision] = useState(0);
  const subject = user ? `${user.organization_id || ''}:${user.employee_id}` : '';

  useEffect(() => {
    if (!enabled || !subject) return;
    let active = true;
    setState({ subject, capabilities: [], loading: true, loaded: false, error: null });
    void getEffectiveWorkforceCapabilities()
      .then((capabilities) => {
        if (active) setState({ subject, capabilities, loading: false, loaded: true, error: null });
      })
      .catch((error: unknown) => {
        if (!active) return;
        setState({
          subject,
          capabilities: [],
          loading: false,
          loaded: true,
          error: error instanceof Error ? error.message : 'Không tải được quyền truy cập hiện hành.',
        });
      });
    return () => { active = false; };
  }, [enabled, revision, subject]);

  const retry = useCallback(() => setRevision((value) => value + 1), []);
  const belongsToCurrentUser = state.subject === subject;
  if (!enabled) return { capabilities: [] as string[], loading: false, error: null as string | null, retry };
  if (!belongsToCurrentUser || !state.loaded) {
    return { capabilities: [] as string[], loading: true, error: null as string | null, retry };
  }
  return { capabilities: state.capabilities, loading: state.loading, error: state.error, retry };
}
