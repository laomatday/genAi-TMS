import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { supabase, isSupabaseConfigured } from '@/core/supabase';
import { fetchMyProfile } from './authService';
import { AuthContext, type AuthContextValue } from './auth-context';
import type { Employee } from '@/shared/types';

async function migrateLegacyAvatar(inlineAvatar: string) {
  const { updateProfileAvatar } = await import('@/modules/tms/services/employee');
  const result = await updateProfileAvatar(inlineAvatar);
  return result.success ? result.avatarUrl : null;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<Employee | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    const restore = async () => {
      if (!isSupabaseConfigured) {
        if (active) {
          setUser(null);
          setLoading(false);
        }
        return;
      }

      const { data } = await supabase.auth.getSession();
      if (!active) return;
      if (!data.session) {
        setUser(null);
        setLoading(false);
        return;
      }

      try {
        const profile = await fetchMyProfile();
        if (active) setUser(profile);
      } catch (error) {
        if (error instanceof Error && error.message !== 'Vui lòng đăng nhập.') {
          console.error('Unable to restore profile:', error);
        }
        await supabase.auth.signOut({ scope: 'local' });
        if (active) setUser(null);
      } finally {
        if (active) setLoading(false);
      }
    };

    void restore();
    const { data: listener } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT' || !session) {
        setUser(null);
        setLoading(false);
      }
    });

    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, []);

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
      login: (u) => {
        setUser(u);
      },
      updateProfile: (profile) => setUser((current) => {
        const next = current ? { ...current, ...profile } : current;
        return next;
      }),
      logout: async () => {
        if (isSupabaseConfigured) {
          try {
            await supabase.auth.signOut({ scope: 'local' });
          } catch {
            // best-effort
          }
        }
        setUser(null);
      },
    }),
    [loading, user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
