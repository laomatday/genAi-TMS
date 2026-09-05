import { useMemo, useState, type FormEvent } from 'react';
import { TMS_DEFAULT_SYSTEM_CONFIG, TMS_LIMITS } from '@/shared/constants';
import { saveQrStation } from '../adminService';
import type { AdminActionRunner, AdminData, QrStationInfo } from '../types';
import { formatDateTime } from '../formatters';
import { AdminSelect, EmptyState, PanelTitle } from './AdminCommon';
import Avatar from '@/shared/components/common/Avatar';

export default function KiosksSection({
  data,
  busy,
  canManage,
  onRun,
  onOpenStation,
}: {
  data: AdminData;
  busy: boolean;
  canManage: boolean;
  onRun: AdminActionRunner;
  onOpenStation: () => void;
}) {
  const [station, setStation] = useState<QrStationInfo | null>(null);
  const kioskAccounts = data.employees.filter((employee) => employee.role === 'Kiosk');
  const settings = useMemo(() => new Map(data.systemSettings.map((item) => [item.key, item.value])), [data.systemSettings]);
  const refreshSeconds = Number(settings.get('QR_REFRESH_SECONDS') || TMS_DEFAULT_SYSTEM_CONFIG.QR_REFRESH_SECONDS);
  const validitySeconds = Number(settings.get('QR_VALIDITY_SECONDS') || TMS_DEFAULT_SYSTEM_CONFIG.QR_VALIDITY_SECONDS);
  const employeesByUid = useMemo(() => new Map(data.employees.map((employee) => [employee.uid || employee.auth_user_id, employee])), [data.employees]);
  const registeredUsers = new Set(data.stations.map((item) => item.station_user_id));
  const waitingAccounts = kioskAccounts.filter((employee) => !registeredUsers.has(employee.uid || employee.auth_user_id || ''));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!station) return;
    await onRun(() => saveQrStation(station), 'Đã cập nhật trạm Kiosk.');
  };

  return (
    <div className="admin-section-stack">
      <section className="admin-kiosk-hero">
        <div className="admin-kiosk-hero-icon"><span className="material-symbols-rounded">qr_code_2</span></div>
        <div>
          <span>Dynamic QR · GPS · Trusted Device</span>
          <h2>Trạm chỉ hiển thị QR, không cần camera</h2>
          <p>Nhân viên dùng điện thoại quét mã và gửi GPS. QR làm mới mỗi {refreshSeconds} giây, hiệu lực {validitySeconds} giây.</p>
        </div>
        <button type="button" className="admin-primary-button" onClick={onOpenStation}><span className="material-symbols-rounded">open_in_full</span>Mở trạm toàn màn hình</button>
      </section>

      <div className="admin-split-layout kiosk-layout">
        <section className="admin-panel admin-list-panel">
          <PanelTitle eyebrow={`${data.stations.length} trạm đã đăng ký`} title="Thiết bị Kiosk" />
          <div className="admin-kiosk-list">
            {data.stations.map((item) => {
              const owner = employeesByUid.get(item.station_user_id);
              const lastSeen = item.updated_at ? new Date(item.updated_at).getTime() : 0;
              const online = item.active && Date.now() - lastSeen <= TMS_LIMITS.KIOSK_ONLINE_WINDOW_MS;
              return (
                <button type="button" className={station?.id === item.id ? 'selected' : ''} onClick={() => setStation({ ...item })} key={item.id}>
                  <span className={`admin-kiosk-state ${online ? 'online' : ''}`}><i /><span className="material-symbols-rounded">desktop_windows</span></span>
                  <span><strong>{item.name}</strong><small>{owner?.name || item.created_by || 'Chưa rõ tài khoản'} · {item.center_id}</small><em>{online ? 'Đang trực tuyến' : item.active ? `Mất kết nối · ${formatDateTime(item.updated_at)}` : 'Đã vô hiệu hóa'}</em></span>
                  <span className="material-symbols-rounded">chevron_right</span>
                </button>
              );
            })}
            {!data.stations.length ? <EmptyState icon="desktop_windows" title="Chưa có trạm" description="Tạo tài khoản Kiosk, đăng nhập lần đầu và mở mã QR để tự đăng ký trạm." /> : null}
          </div>
        </section>

        <section className="admin-panel admin-kiosk-editor">
          <PanelTitle eyebrow="Station registry" title={station ? 'Cấu hình trạm' : 'Hướng dẫn kích hoạt'} />
          {station ? (
            <form className="admin-editor" onSubmit={(event) => void submit(event)}>
              {!canManage ? <span className="admin-role-badge">Chỉ Admin được thay đổi cấu hình trạm</span> : null}
              <fieldset disabled={!canManage || busy}>
                <div className="admin-form-grid">
                  <label className="admin-grid-span"><span>Tên hiển thị</span><input required value={station.name} onChange={(event) => setStation((current) => current ? { ...current, name: event.target.value } : current)} /></label>
                  <div className="admin-field admin-grid-span"><span>Địa điểm</span><AdminSelect required disabled={!canManage || busy} value={station.center_id} onChange={(value) => setStation((current) => current ? { ...current, center_id: value } : current)} label="Địa điểm Kiosk" options={data.locations.filter((location) => location.active).map((location) => ({ value: location.center_id, label: location.center_name }))} /></div>
                </div>
                <div className="admin-kiosk-identity"><span className="material-symbols-rounded">fingerprint</span><div><strong>Station user ID</strong><small>{station.station_user_id}</small></div></div>
                <label className="admin-switch"><input type="checkbox" checked={station.active} onChange={(event) => setStation((current) => current ? { ...current, active: event.target.checked } : current)} /><span><strong>Cho phép phát QR</strong><small>Khi tắt, lần làm mới tiếp theo của trạm sẽ bị từ chối.</small></span></label>
                {canManage ? <footer className="admin-editor-actions"><button className="admin-primary-button" disabled={busy}><span className="material-symbols-rounded">save</span>Lưu trạm</button></footer> : null}
              </fieldset>
            </form>
          ) : (
            <ol className="admin-steps"><li><span>1</span><div><strong>Tạo tài khoản Kiosk</strong><p>Vào mục Tài khoản, chọn vai trò Kiosk và gán địa điểm chính.</p></div></li><li><span>2</span><div><strong>Đăng nhập trên màn hình trạm</strong><p>Tài khoản Kiosk tự đi thẳng vào màn hình QR.</p></div></li><li><span>3</span><div><strong>Quản lý tại đây</strong><p>Đổi tên, chuyển địa điểm hoặc thu hồi quyền phát QR.</p></div></li></ol>
          )}
        </section>
      </div>

      {waitingAccounts.length ? (
        <section className="admin-panel">
          <PanelTitle eyebrow="Chờ kết nối lần đầu" title="Tài khoản Kiosk chưa đăng ký trạm" />
          <div className="admin-waiting-list">{waitingAccounts.map((employee) => <article key={employee.employee_id}><Avatar src={employee.avatar_url || employee.face_ref_url} name={employee.name} className="admin-avatar" textSize="" /><div><strong>{employee.name}</strong><small>{employee.employee_id} · {employee.center_id}</small></div><b className="admin-status status-pending_review">Chờ đăng nhập</b></article>)}</div>
        </section>
      ) : null}
    </div>
  );
}
