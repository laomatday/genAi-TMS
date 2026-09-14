import { Component, type ErrorInfo, type ReactNode } from 'react';
import { reportClientError } from '@/core/observability/clientTelemetry';
import { APP_INFO } from '@/shared/constants';

interface Props { children: ReactNode; }
interface State { incidentId: string | null; }

function createIncidentId() {
  const id = typeof crypto?.randomUUID === 'function'
    ? (crypto.randomUUID().split('-')[0] || Date.now().toString(36))
    : Date.now().toString(36);
  return `UI-${id.toUpperCase()}`;
}

export default class AppErrorBoundary extends Component<Props, State> {
  state: State = { incidentId: null };

  static getDerivedStateFromError(): State {
    return { incidentId: createIncidentId() };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    reportClientError('APP_RENDER_ERROR', error);
    if (import.meta.env.DEV) console.error('Application render failed', error, info);
  }

  private retry = () => {
    this.setState({ incidentId: null });
  };

  render() {
    const { incidentId } = this.state;
    if (!incidentId) return this.props.children;

    return (
      <main className="app-fatal" role="alert" aria-labelledby="app-fatal-title">
        <section className="app-fatal-card">
          <img className="app-fatal-logo" src={APP_INFO.LOGO_URL} alt="" aria-hidden="true" />
          <span className="app-fatal-eyebrow">Khôi phục an toàn</span>
          <h1 id="app-fatal-title">Ứng dụng chưa thể hiển thị</h1>
          <p>Dữ liệu chấm công chưa bị thay đổi. Hãy thử mở lại màn hình; nếu lỗi còn lặp lại, gửi mã sự cố cho bộ phận hỗ trợ.</p>
          <code className="app-fatal-incident">{incidentId}</code>
          <div className="app-fatal-actions">
            <button type="button" className="app-fatal-primary" onClick={this.retry}>Thử lại</button>
            <button type="button" className="app-fatal-secondary" onClick={() => window.location.reload()}>Tải lại ứng dụng</button>
          </div>
          <small>{APP_INFO.PRODUCT_NAME} v{APP_INFO.VERSION} · build {APP_INFO.BUILD_ID}</small>
        </section>
      </main>
    );
  }
}
