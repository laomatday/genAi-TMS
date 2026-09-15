import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { supabase, isSupabaseConfigured } from '@/core/supabase';
import { fetchMyProfile } from './authService';
import { AuthContext, type AuthContextValue } from './auth-context';
import {
  AUTH_RESTORE_UNAVAILABLE_MESSAGE,
  createAuthOperationGuard,
  isRetryableAuthFailure,
  withAuthDeadline,
} from './authFailure';
import type { Employee } from '@/shared/types';

async function migrateLegacyAvatar(inlineAvatar: string) {
  const { updateProfileAvatar } = await import('@/modules/tms/services/employee');
  const result = await updateProfileAvatar(inlineAvatar);
  return result.success ? result.avatarUrl : null;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<Employee | null>(null);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const [restoreRevision, setRestoreRevision] = useState(0);
  const authOperationRef = useRef<ReturnType<typeof createAuthOperationGuard> | null>(null);
  // Vite Fast Refresh can preserve a ref created by an older module shape.
  // Reinitialize it defensively so a local HMR update cannot crash AuthProvider.
  if (!authOperationRef.current || typeof authOperationRef.current.begin !== 'function') {
    authOperationRef.current = createAuthOperationGuard();
  }
  const authOperations = authOperationRef.current;
  const retryAuth = useCallback(() => setRestoreRevision((revision) => revision + 1), []);

  useEffect(() => {
    let active = true;
    const isLatestOperation = authOperations.begin();
    const isCurrentOperation = () => active && isLatestOperation();

    const restore = async () => {
      setLoading(true);
      setAuthError(null);

      if (!isSupabaseConfigured) {
        if (isCurrentOperation()) {
          setUser(null);
          setLoading(false);
        }
        return;
      }

      try {
        const { data, error } = await withAuthDeadline(supabase.auth.getSession());
        if (error) throw error;
        if (!isCurrentOperation()) return;
        if (!data.session) {
          setUser(null);
          return;
        }

        const profile = await withAuthDeadline(fetchMyProfile(data.session.user.id));
        if (isCurrentOperation()) {
          setUser(profile);
          setAuthError(null);
        }
      } catch (error) {
        if (isRetryableAuthFailure(error)) {
          if (isCurrentOperation()) {
            console.warn('Authentication service temporarily unavailable:', error);
            setAuthError(AUTH_RESTORE_UNAVAILABLE_MESSAGE);
          }
          return;
        }
        if (error instanceof Error && error.message !== 'Vui lòng đăng nhập.') {
          console.error('Unable to restore profile:', error);
        }
        try {
          await withAuthDeadline(supabase.auth.signOut({ scope: 'local' }));
        } catch (signOutError) {
          console.warn('Unable to complete remote sign-out:', signOutError);
        }
        if (isCurrentOperation()) setUser(null);
      } finally {
        if (isCurrentOperation()) setLoading(false);
      }
    };

    void restore();
    const { data: listener } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') {
        authOperations.invalidate();
        setUser(null);
        setAuthError(null);
        setLoading(false);
      }
    });

    return () => {
      active = false;
      if (isLatestOperation()) authOperations.invalidate();
      listener.subscription.unsubscribe();
    };
  }, [authOperations, restoreRevision]);

  const legacyAvatar = [user?.avatar_url, user?.face_ref_url]
    .find((value) => value?.startsWith('data:image/')) || '';
  useEffect(() => {
    if (!user || !legacyAvatar) return undefined;
    let active = true;
    const employeeId = user.employee_id;
    void migrateLegacyAvatar(legacyAvatar).then((avatarUrl) => {
      if (!active || !avatarUrl) return;
      setUser((current) => current?.employee_id === employeeId
        ? { ...current, avatar_url: avatarUrl, face_ref_url: avatarUrl }
        : current);
    }).catch((error) => console.error('Unable to migrate legacy avatar:', error));
    return () => { active = false; };
  }, [user?.employee_id, legacyAvatar]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      loading,
      authError,
      retryAuth,
      login: (u) => {
        authOperations.invalidate();
        setAuthError(null);
        setUser(u);
      },
      updateProfile: (profile) => setUser((current) => {
        const next = current ? { ...current, ...profile } : current;
        return next;
      }),
      logout: async () => {
        authOperations.invalidate();
        setAuthError(null);
        setLoading(false);
        setUser(null);
        if (isSupabaseConfigured) {
          try {
            await withAuthDeadline(supabase.auth.signOut({ scope: 'local' }));
          } catch (error) {
            console.warn('Unable to complete remote sign-out:', error);
          }
        }
      },
    }),
    [authError, loading, retryAuth, user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
