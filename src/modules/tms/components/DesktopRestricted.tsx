import type { Employee } from '@/shared/types';
import { APP_INFO } from '@/shared/constants';

interface Props {
  user: Employee;
  onLogout: () => void;
}

export default function DesktopRestricted({ user, onLogout }: Props) {
  return (
    <main className="desktop-restricted">
      <div className="desktop-restricted-card">
        <span className="material-symbols-rounded" aria-hidden="true">smartphone</span>
        <h1>Chỉ dùng trên điện thoại</h1>
        <p>
          Tài khoản <strong>{user.name}</strong> chỉ chấm công được trên điện thoại.
          Vui lòng mở <strong>{APP_INFO.PRODUCT_NAME}</strong> trên điện thoại của bạn.
        </p>
        <button type="button" className="btn btn-secondary btn-md" onClick={onLogout}>
          <span className="material-symbols-rounded" aria-hidden="true">logout</span>
          Đăng xuất
        </button>
      </div>
    </main>
  );
}
