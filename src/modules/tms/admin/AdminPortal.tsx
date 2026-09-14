import { Link } from 'react-router-dom';
import { APP_ROUTES } from '@/shared/constants';
import type { Employee } from '@/shared/types';
import Avatar from '@/shared/components/common/Avatar';

const PORTAL_OPTIONS = [
  {
    path: APP_ROUTES.ATTENDANCE,
    icon: 'schedule',
    eyebrow: 'Cá nhân',
    title: 'Chấm công',
    description: 'Chấm công, xem lịch sử và gửi đề xuất cá nhân.',
    tone: 'attendance',
  },
  {
    path: APP_ROUTES.ADMIN,
    icon: 'admin_panel_settings',
    eyebrow: 'Điều hành',
    title: 'Trang Admin',
    description: 'Quản trị nhân sự, bảng công và tham số hệ thống.',
    tone: 'admin',
  },
  {
    path: APP_ROUTES.KIOSK,
    icon: 'qr_code_2',
    eyebrow: 'Thiết bị',
    title: 'Trang Kiosk',
    description: 'Mở trạm QR động phục vụ chấm công tại văn phòng.',
    tone: 'kiosk',
  },
] as const;

export default function AdminPortal({ user, onLogout }: { user: Employee; onLogout: () => void }) {
  return (
    <main className="admin-portal-page">
      <header className="admin-portal-header">
        <div className="admin-portal-account">
          <Avatar src={user.avatar_url || user.face_ref_url} name={user.name} className="admin-portal-avatar" textSize="" />
          <span className="admin-portal-identity">
            <strong>{user.name}</strong>
            <small>Tài khoản quản trị</small>
          </span>
        </div>
        <button type="button" className="admin-portal-logout" onClick={onLogout}>
          <span className="material-symbols-rounded" aria-hidden="true">logout</span>
          <span>Đăng xuất</span>
        </button>
      </header>

      <section className="admin-portal-content" aria-labelledby="admin-portal-title">
        <div className="admin-portal-intro">
          <p className="eyebrow">Không gian làm việc</p>
          <h1 id="admin-portal-title">Xin chào, {user.name}</h1>
          <p>Chọn khu vực bạn muốn truy cập.</p>
        </div>

        <nav className="admin-portal-grid" aria-label="Chọn khu vực làm việc">
          {PORTAL_OPTIONS.map((option) => (
            <Link className={`admin-portal-card admin-portal-card-${option.tone}`} to={option.path} key={option.path}>
              <span className="admin-portal-card-icon material-symbols-rounded" aria-hidden="true">{option.icon}</span>
              <span className="admin-portal-card-copy">
                <small>{option.eyebrow}</small>
                <strong>{option.title}</strong>
                <span>{option.description}</span>
              </span>
              <span className="admin-portal-card-action" aria-hidden="true">
                Truy cập
                <span className="material-symbols-rounded">arrow_forward</span>
              </span>
            </Link>
          ))}
        </nav>
      </section>
    </main>
  );
}
