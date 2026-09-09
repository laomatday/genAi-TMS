import React from 'react';

// A lightweight skeleton of the employee shell shown while auth resolves or a
// lazy route chunk loads — replaces the old full-screen spinner.
const LoadingScreen: React.FC = () => (
  <div className="app-skeleton" role="status" aria-live="polite" aria-label="Đang tải ứng dụng">
    <div className="app-skeleton-topbar">
      <span className="skeleton app-skeleton-avatar" />
      <span className="skeleton app-skeleton-pill" />
    </div>
    <div className="app-skeleton-body">
      <span className="skeleton app-skeleton-hero" />
      <div className="app-skeleton-grid">
        <span className="skeleton app-skeleton-card" />
        <span className="skeleton app-skeleton-card" />
        <span className="skeleton app-skeleton-card" />
        <span className="skeleton app-skeleton-card" />
      </div>
      <span className="skeleton app-skeleton-line" />
      <span className="skeleton app-skeleton-line app-skeleton-line-short" />
    </div>
  </div>
);

export default LoadingScreen;
