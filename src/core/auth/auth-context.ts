import { createContext } from 'react';
import type { Employee } from '@/shared/types';

export interface AuthContextValue {
  user: Employee | null;
  loading: boolean;
  authError: string | null;
  retryAuth: () => void;
  login: (profile: Employee) => void;
  updateProfile: (profile: Partial<Employee>) => void;
  logout: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);
