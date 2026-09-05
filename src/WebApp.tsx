import React from 'react';
import { AuthProvider } from '@/core/auth/AuthContext';
import AppRouter from '@/core/router';
import { ThemeProvider } from '@/shared/contexts/ThemeContext';
import { ToastProvider } from '@/shared/contexts/ToastContext';

const WebApp: React.FC = () => (
  <ThemeProvider>
    <AuthProvider>
      <ToastProvider>
        <AppRouter />
      </ToastProvider>
    </AuthProvider>
  </ThemeProvider>
);

export default WebApp;
