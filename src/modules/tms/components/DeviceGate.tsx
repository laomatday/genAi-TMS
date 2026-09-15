import { useEffect, useState, type ReactNode } from 'react';
import type { Employee } from '@/shared/types';
import {
  activateTrustedDevice,
  getDeviceBindingStatus,
  getDeviceLabel,
  hasServerVerifiedDeviceGrant,
  isServerAuthorizedDeviceExemption,
  verifyTrustedDevice,
} from '@/core/deviceBinding';
import { APP_INFO, DEVICE_EXEMPT_ROLES } from '@/shared/constants';
import LoadingScreen from '@/shared/components/common/LoadingScreen';

type DeviceGateState = 'checking' | 'activate' | 'verifying' | 'ready' | 'blocked';

export default function DeviceGate({ user, onLogout, children }: { user: Employee; onLogout: () => void; children: ReactNode }) {
  const exempt = DEVICE_EXEMPT_ROLES.includes(user.role);
  const [state, setState] = useState<DeviceGateState>(exempt ? 'ready' : 'checking');
  const [message, setMessage] = useState('Đang kiểm tra thiết bị tin cậy…');

  useEffect(() => {
    if (exempt) {
      setState('ready');
      return;
    }
    let active = true;
    setState('checking');
    setMessage('Đang kiểm tra thiết bị tin cậy…');
    void (async () => {
      try {
        const status = await getDeviceBindingStatus();
        if (!active) return;
        // The server owns the exemption decision. Older trusted-device
        // deployments return EXEMPT for Admin/Kiosk, while the hardened
        // deployment only exempts Kiosk. In both cases the client must honor
        // the server response instead of attempting a challenge without a key.
        if (isServerAuthorizedDeviceExemption(status)) {
          setState('ready');
          return;
        }
        // A still-valid grant is authoritative server state. Reusing it avoids
        // a redundant challenge/sign/verify round trip on every reload while
        // a different logical device is still rejected by the status call.
        if (hasServerVerifiedDeviceGrant(status)) {
          setState('ready');
          return;
        }
        if (status.needsActivation || status.state === 'NEEDS_ACTIVATION') {
          setMessage('Tài khoản chưa có thiết bị tin cậy.');
          setState('activate');
          return;
        }
        if (!status.ok || status.state === 'BLOCKED') {
          setMessage(status.error || 'Tài khoản đang liên kết với thiết bị khác.');
          setState('blocked');
          return;
        }
        setState('verifying');
        setMessage('Đang xác minh khóa bảo mật trên thiết bị…');
        try {
          await verifyTrustedDevice();
          if (active) setState('ready');
        } catch (error) {
          if (!active) return;
          setMessage(error instanceof Error ? error.message : 'Không xác thực được thiết bị.');
          setState('blocked');
        }
      } catch (error) {
        if (!active) return;
        setMessage(error instanceof Error ? error.message : 'Không kiểm tra được thiết bị.');
        setState('blocked');
      }
    })();
    return () => { active = false; };
  }, [exempt, user.employee_id, user.organization_id]);

  if (state === 'ready') return <>{children}</>;
  if (state === 'checking' || state === 'verifying') return <LoadingScreen />;

  const activate = async () => {
    setState('verifying');
    setMessage('Đang tạo khóa bảo mật và kích hoạt thiết bị…');
    try {
      await activateTrustedDevice();
      setState('ready');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Không kích hoạt được thiết bị.');
      setState('blocked');
    }
  };

  return (
    <main className="tms-device-gate">
      <section className="tms-device-card">
        <div className="tms-device-logo"><img src={APP_INFO.LOGO_URL} alt={APP_INFO.BRAND} /></div>
        <span className="tms-kicker">Trusted Device</span>
        {state === 'activate' ? (
          <>
            <h1>Kích hoạt thiết bị làm việc</h1>
            <p>Tài khoản <strong>{user.name}</strong> sẽ được liên kết với thiết bị này. Sau khi kích hoạt, anh/chị không thể đăng nhập từ điện thoại khác.</p>
            <div className="tms-device-preview">
              <span className="material-symbols-rounded">smartphone</span>
              <div><strong>{getDeviceLabel()}</strong><small>Thiết bị sẽ dùng khóa bảo mật riêng để xác thực.</small></div>
            </div>
            <div className="tms-device-warning"><span className="material-symbols-rounded">info</span><p>Nếu mất máy, đổi điện thoại hoặc xóa dữ liệu trình duyệt, vui lòng liên hệ Admin để đặt lại thiết bị.</p></div>
            <button className="tms-primary" onClick={() => void activate()}><span className="material-symbols-rounded">verified_user</span>Kích hoạt thiết bị này</button>
          </>
        ) : (
          <>
            <div className="tms-device-blocked"><span className="material-symbols-rounded">phonelink_lock</span></div>
            <h1>Thiết bị chưa được xác thực</h1>
            <p>{message}</p>
            <div className="tms-device-warning"><span className="material-symbols-rounded">support_agent</span><p>Nếu anh/chị vừa đổi hoặc mất điện thoại, hãy liên hệ Admin. Người dùng không thể tự thay thiết bị đã đăng ký.</p></div>
            <button className="tms-secondary" onClick={onLogout}><span className="material-symbols-rounded">logout</span>Đăng xuất</button>
          </>
        )}
      </section>
    </main>
  );
}
