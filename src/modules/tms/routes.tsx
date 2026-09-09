import React, { lazy, useCallback } from 'react';
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { useAuth } from '@/core/auth/useAuth';
import { useIsMobile } from '@/shared/hooks/useIsMobile';
import DeviceGate from '@/modules/tms/components/DeviceGate';
import DesktopRestricted from '@/modules/tms/components/DesktopRestricted';
import LoginView from '@/modules/tms/components/LoginView';
import LoadingScreen from '@/shared/components/common/LoadingScreen';
import { ADMIN_ROUTE_ROLES, APP_ROUTES } from '@/shared/constants';
import type { Employee } from '@/shared/types';

const EmployeeApp = lazy(() => import('@/modules/tms/components/AppShell'));
const AdminApp = lazy(() => import('@/modules/tms/admin/AdminApp'));
const AdminPortal = lazy(() => import('@/modules/tms/admin/AdminPortal'));
const QrStation = lazy(() => import('@/modules/tms/components/QrStation'));

const TmsRoutes: React.FC = () => {
  const { user, loading, login, logout } = useAuth();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const handleLoginSuccess = useCallback((authenticatedUser: Employee) => {
    navigate(APP_ROUTES.HOME, { replace: true });
    login(authenticatedUser);
  }, [login, navigate]);

  if (loading) return <LoadingScreen />;
  if (!user) return <LoginView onLoginSuccess={handleLoginSuccess} />;

  if (user.role === 'Kiosk') {
    return <QrStation user={user} onExit={() => void logout()} />;
  }

  const canAdmin = ADMIN_ROUTE_ROLES.includes(user.role);

  // Desktop / tablet: everyday accounts are phone-only. Admin-portal roles
  // (Admin / HR / Director) keep full access.
  if (!isMobile && !canAdmin) {
    return <DesktopRestricted user={user} onLogout={() => void logout()} />;
  }

  const onOpenWorkspace = user.role === 'Admin'
    ? () => navigate(isMobile ? APP_ROUTES.ADMIN : APP_ROUTES.HOME)
    : undefined;
  const employeeApp = (
    <DeviceGate user={user} onLogout={() => void logout()}>
      <EmployeeApp user={user} onLogout={() => void logout()} onOpenWorkspace={onOpenWorkspace} />
    </DeviceGate>
  );
  const adminApp = user.role === 'Admin' ? (
    <AdminApp user={user} onLogout={() => void logout()} />
  ) : (
    <DeviceGate user={user} onLogout={() => void logout()}>
      <AdminApp user={user} onLogout={() => void logout()} />
    </DeviceGate>
  );

  // Mobile: every role lands straight in the TMS employee app.
  if (isMobile) {
    return (
      <Routes>
        <Route path={APP_ROUTES.ADMIN} element={canAdmin ? adminApp : <Navigate to={APP_ROUTES.HOME} replace />} />
        <Route
          path={APP_ROUTES.KIOSK}
          element={canAdmin ? <QrStation user={user} onExit={() => navigate(APP_ROUTES.HOME, { replace: true })} /> : <Navigate to={APP_ROUTES.HOME} replace />}
        />
        <Route path="*" element={employeeApp} />
      </Routes>
    );
  }

  // Desktop / tablet (admin-portal roles): unchanged behaviour.
  return (
    <Routes>
      <Route
        path={APP_ROUTES.HOME}
        element={user.role === 'Admin' ? <AdminPortal user={user} onLogout={() => void logout()} /> : employeeApp}
      />
      <Route
        path={APP_ROUTES.ATTENDANCE}
        element={user.role === 'Admin' ? employeeApp : <Navigate to={APP_ROUTES.HOME} replace />}
      />
      <Route path={APP_ROUTES.ADMIN} element={canAdmin ? adminApp : <Navigate to={APP_ROUTES.HOME} replace />} />
      <Route
        path={APP_ROUTES.KIOSK}
        element={canAdmin ? <QrStation user={user} onExit={() => navigate(APP_ROUTES.HOME, { replace: true })} /> : <Navigate to={APP_ROUTES.HOME} replace />}
      />
      <Route path="*" element={<Navigate to={APP_ROUTES.HOME} replace />} />
    </Routes>
  );
};

export default TmsRoutes;
