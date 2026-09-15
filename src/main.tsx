import React from 'react';
import ReactDOM from 'react-dom/client';
import WebApp from '@/WebApp';
import AppErrorBoundary from '@/core/errors/AppErrorBoundary';
import { installGlobalErrorReporting } from '@/core/observability/clientTelemetry';
import { installStaleBuildRecovery } from '@/core/errors/staleBuild';
import AppStatusBanner, { PWA_UPDATE_AVAILABLE_EVENT, type PwaUpdateAvailableDetail } from '@/shared/components/common/AppStatusBanner';
import '@/style.css';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Failed to find the root element');
installGlobalErrorReporting();
// Registered before the first render so a chunk that went missing in a deploy
// is recovered silently, instead of reaching the error screen.
installStaleBuildRecovery();

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <WebApp />
      <AppStatusBanner />
    </AppErrorBoundary>
  </React.StrictMode>
);

async function clearDevelopmentPwaState() {
  const resetKey = 'genai_tms_dev_pwa_reset';
  if (sessionStorage.getItem(resetKey) === 'done') return;
  sessionStorage.setItem(resetKey, 'done');

  const registrations = 'serviceWorker' in navigator
    ? await navigator.serviceWorker.getRegistrations()
    : [];
  const cacheKeys = 'caches' in window ? await caches.keys() : [];
  await Promise.all([
    ...registrations.map((registration) => registration.unregister()),
    ...cacheKeys.map((cacheKey) => caches.delete(cacheKey)),
  ]);
}

async function registerProductionPwa() {
  let reloading = false;
  let checking = false;
  let reloadRequested = false;

  const reload = () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  };

  try {
    const registration = await navigator.serviceWorker.register('/sw.js', {
      updateViaCache: 'none',
    });

    const applyAvailableUpdate = () => {
      const waitingWorker = registration.waiting;
      if (!waitingWorker) {
        reload();
        return;
      }

      reloadRequested = true;
      waitingWorker.postMessage({ type: 'SKIP_WAITING' });
      window.setTimeout(reload, 5_000);
    };
    const announceUpdate = () => {
      window.dispatchEvent(new CustomEvent<PwaUpdateAvailableDetail>(PWA_UPDATE_AVAILABLE_EVENT, {
        detail: { apply: applyAvailableUpdate },
      }));
    };
    const watchInstallingWorker = (worker: ServiceWorker | null) => {
      if (!worker) return;
      worker.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) announceUpdate();
      });
    };

    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloadRequested) reload();
    });
    registration.addEventListener('updatefound', () => watchInstallingWorker(registration.installing));
    if (registration.waiting) announceUpdate();

    const checkForUpdate = async () => {
      if (checking || reloading) return;
      checking = true;

      try {
        await registration.update();
        const response = await fetch(`/index.html?app-update=${Date.now()}`, { cache: 'no-store' });
        if (!response.ok) return;

        const latestDocument = new DOMParser().parseFromString(await response.text(), 'text/html');
        const currentEntry = document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.src;
        const latestEntryPath = latestDocument.querySelector<HTMLScriptElement>('script[type="module"][src]')?.getAttribute('src');
        const latestEntry = latestEntryPath ? new URL(latestEntryPath, window.location.origin).href : undefined;
        if (currentEntry && latestEntry && currentEntry !== latestEntry) announceUpdate();
      } catch {
        // Update checks are best-effort and must not interrupt attendance flows.
      } finally {
        checking = false;
      }
    };

    void checkForUpdate();
    window.addEventListener('focus', () => void checkForUpdate());
    window.addEventListener('online', () => void checkForUpdate());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void checkForUpdate();
    });
  } catch {
    // The application remains usable when service workers are unavailable.
  }
}

if (import.meta.env.DEV) {
  void clearDevelopmentPwaState();
} else if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void registerProductionPwa();
  });
}
