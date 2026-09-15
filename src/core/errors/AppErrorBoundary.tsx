import { Component, type ErrorInfo, type ReactNode } from 'react';
import { reportClientError } from '@/core/observability/clientTelemetry';
import { isStaleBuildError, recoverFromStaleBuild, shouldReloadForStaleBuild } from '@/core/errors/staleBuild';
import { APP_INFO } from '@/shared/constants';

interface Props { children: ReactNode; }
interface State { incidentId: string | null; stale: boolean; }

function createIncidentId() {
  const id = typeof crypto?.randomUUID === 'function'
    ? (crypto.randomUUID().split('-')[0] || Date.now().toString(36))
    : Date.now().toString(36);
  return `UI-${id.toUpperCase()}`;
}

export default class AppErrorBoundary extends Component<Props, State> {
  state: State = { incidentId: null, stale: false };

  static getDerivedStateFromError(error: unknown): State {
    return { incidentId: createIncidentId(), stale: isStaleBuildError(error) };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    const stale = isStaleBuildError(error);
    // Separated in telemetry because the two need different responses: a stale
    // build is a deploy artefact that clears itself, an ordinary render error
    // is a bug to go and find.
    reportClientError(stale ? 'APP_RENDER_ERROR_STALE_BUILD' : 'APP_RENDER_ERROR', error);
    if (import.meta.env.DEV) console.error('Application render failed', error, info);
    // A module that is no longer on the server will not appear on a re-render,
    // so recover without waiting for the user to work that out.
    if (stale && shouldReloadForStaleBuild(globalThis.sessionStorage)) void recoverFromStaleBuild();
  }

  private retry = () => {
    // Re-rendering cannot bring back a chunk the deployment no longer serves.
    if (this.state.stale) { void recoverFromStaleBuild(); return; }
    this.setState({ incidentId: null, stale: false });
  };

  private reload = () => { void recoverFromStaleBuild(); };

  render() {
    const { incidentId, stale } = this.state;
    if (!incidentId) return this.props.children;

    return (
      <main className="app-fatal" role="alert" aria-labelledby="app-fatal-title">
        <section className="app-fatal-card">
          <img className="app-fatal-logo" src={APP_INFO.LOGO_URL} alt="" aria-hidden="true" />
          <span className="app-fatal-eyebrow">Khôi phục an toàn</span>
          <h1 id="app-fatal-title">Ứng dụng chưa thể hiển thị</h1>
          <p>
            {stale
              ? 'Ứng dụng vừa được cập nhật nên phiên bản đang mở đã cũ. Dữ liệu chấm công chưa bị thay đổi — tải lại là dùng được ngay.'
              : 'Dữ liệu chấm công chưa bị thay đổi. Hãy thử mở lại màn hình; nếu lỗi còn lặp lại, gửi mã sự cố cho bộ phận hỗ trợ.'}
          </p>
          <code className="app-fatal-incident">{incidentId}</code>
          <div className="app-fatal-actions">
            <button type="button" className="app-fatal-primary" onClick={this.retry}>{stale ? 'Cập nhật ngay' : 'Thử lại'}</button>
            <button type="button" className="app-fatal-secondary" onClick={this.reload}>Tải lại ứng dụng</button>
          </div>
          <small>{APP_INFO.PRODUCT_NAME} v{APP_INFO.VERSION} · build {APP_INFO.BUILD_ID}</small>
        </section>
      </main>
    );
  }
}
