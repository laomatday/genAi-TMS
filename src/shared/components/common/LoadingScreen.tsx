import React from 'react';
import Spinner from '@/shared/components/common/Spinner';

const LoadingScreen: React.FC = () => (
  <main className="app-loading-screen" role="status" aria-live="polite">
    <div className="app-loading-state">
      <Spinner size="md" />
      <p>Đang xác thực phiên làm việc…</p>
    </div>
  </main>
);

export default LoadingScreen;
