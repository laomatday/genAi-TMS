import React, { Suspense } from 'react';
import { BrowserRouter } from 'react-router-dom';
import TmsRoutes from '@/modules/tms/routes';
import LoadingScreen from '@/shared/components/common/LoadingScreen';

const AppRouter: React.FC = () => (
  <BrowserRouter>
    <Suspense fallback={<LoadingScreen />}>
      <TmsRoutes />
    </Suspense>
  </BrowserRouter>
);

export default AppRouter;
