import React, { lazy, useCallback } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '@/core/auth/useAuth';
import { useIsMobile } from '@/shared/hooks/useIsMobile';
import { useWorkforceCapabilities } from '@/modules/tms/hooks/useWorkforceCapabilities';
import { canOpenKioskStation, hasControlCenterAccess } from '@/modules/tms/services/workforceCapabilities';
import DeviceGate from '@/modules/tms/components/DeviceGate';
import DesktopRestricted from '@/modules/tms/components/DesktopRestricted';
import LoginView from '@/modules/tms/components/LoginView';
import LoadingScreen from '@/shared/components/common/LoadingScreen';
import { APP_ROUTES } from '@/shared/constants';
import type { Employee } from '@/shared/types';

const EmployeeApp = lazy(() => import('@/modules/tms/components/AppShell'));
const AdminApp = lazy(() => import('@/modules/tms/admin/AdminApp'));
const AdminPortal = lazy(() => import('@/modules/tms/admin/AdminPortal'));
const QrStation = lazy(() => import('@/modules/tms/components/QrStation'));

function CapabilityLoadError({ message, onRetry, onLogout }: { message: string; onRetry: () => void; onLogout: () => void }) {
  return (
    <main className="h-full w-full page-bg flex items-center justify-center p-6">
      <section className="empty-state-card" role="alert">
        <span className="material-symbols-rounded empty-state-icon" aria-hidden="true">shield_lock</span>
        <h2>Chưa xác minh được quyền truy cập</h2>
        <p>{message}</p>
        <div className="flex flex-wrap justify-center gap-2">
          <button type="button" className="btn btn-primary btn-md" onClick={onRetry}>Thử lại</button>
          <button type="button" className="btn btn-secondary btn-md" onClick={onLogout}>Đăng xuất</button>
        </div>
      </section>
    </main>
  );
}

const TmsRoutes: React.FC = () => {
  const { user, loading, login, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const isMobile = useIsMobile();
  const protectedWorkspaceRoute = location.pathname === APP_ROUTES.ADMIN || location.pathname === APP_ROUTES.KIOSK;
  const needsCapabilities = Boolean(user && user.role !== 'Kiosk' && (!isMobile || protectedWorkspaceRoute));
  const capabilityState = useWorkforceCapabilities(user, needsCapabilities);
  const handleLoginSuccess = useCallback((authenticatedUser: Employee) => {
    navigate(APP_ROUTES.HOME, { replace: true });
    login(authenticatedUser);
  }, [login, navigate]);

  if (loading) return <LoadingScreen />;
  if (!user) return <LoginView onLoginSuccess={handleLoginSuccess} />;

  if (user.role === 'Kiosk') {
    return (
      <DeviceGate user={user} onLogout={() => void logout()}>
        <QrStation user={user} onExit={() => void logout()} />
      </DeviceGate>
    );
  }

  if (needsCapabilities && capabilityState.loading) return <LoadingScreen />;
  if (needsCapabilities && capabilityState.error) {
    return (
      <CapabilityLoadError
        message={capabilityState.error}
        onRetry={capabilityState.retry}
        onLogout={() => void logout()}
      />
    );
  }

  const canOpenWorkspace = hasControlCenterAccess(capabilityState.capabilities);
  const canOpenKiosk = canOpenKioskStation(user.role, capabilityState.capabilities);

  // Desktop / tablet: everyday accounts are phone-only. Admin-portal roles
  // are derived from effective tenant capabilities, including employee overrides.
  if (!isMobile && !canOpenWorkspace) {
    return <DesktopRestricted user={user} onLogout={() => void logout()} />;
  }

  const onOpenWorkspace = () => navigate(APP_ROUTES.ADMIN);
  const employeeApp = (
    <DeviceGate user={user} onLogout={() => void logout()}>
      <EmployeeApp user={user} onLogout={() => void logout()} onOpenWorkspace={onOpenWorkspace} />
    </DeviceGate>
  );
  const adminApp = (
    <DeviceGate user={user} onLogout={() => void logout()}>
      <AdminApp user={user} onLogout={() => void logout()} />
    </DeviceGate>
  );
  const qrStation = (
    <DeviceGate user={user} onLogout={() => void logout()}>
      <QrStation user={user} onExit={() => navigate(APP_ROUTES.HOME, { replace: true })} />
    </DeviceGate>
  );

  // Mobile: every role lands straight in the TMS employee app.
  if (isMobile) {
    return (
      <Routes>
        <Route path={APP_ROUTES.ADMIN} element={canOpenWorkspace ? adminApp : <Navigate to={APP_ROUTES.HOME} replace />} />
        <Route
          path={APP_ROUTES.KIOSK}
          element={canOpenKiosk ? qrStation : <Navigate to={APP_ROUTES.HOME} replace />}
        />
        <Route path="*" element={employeeApp} />
      </Routes>
    );
  }

  // Desktop / tablet operators enter through a capability-filtered portal.
  return (
    <Routes>
      <Route
        path={APP_ROUTES.HOME}
        element={<AdminPortal user={user} capabilities={capabilityState.capabilities} onLogout={() => void logout()} />}
      />
      <Route
        path={APP_ROUTES.ATTENDANCE}
        element={capabilityState.capabilities.includes('attendance.self') ? employeeApp : <Navigate to={APP_ROUTES.HOME} replace />}
      />
      <Route path={APP_ROUTES.ADMIN} element={canOpenWorkspace ? adminApp : <Navigate to={APP_ROUTES.HOME} replace />} />
      <Route
        path={APP_ROUTES.KIOSK}
        element={canOpenKiosk ? qrStation : <Navigate to={APP_ROUTES.HOME} replace />}
      />
      <Route path="*" element={<Navigate to={APP_ROUTES.HOME} replace />} />
    </Routes>
  );
};

export default TmsRoutes;
