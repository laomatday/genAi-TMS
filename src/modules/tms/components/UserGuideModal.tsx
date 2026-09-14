import { useState } from 'react';
import { triggerHaptic } from '@/core/utils/helpers';
import { STORAGE_KEYS } from '@/shared/constants';
import { useModalAccessibility } from '@/shared/components/modals/useModalAccessibility';

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

const GUIDE_SECTIONS = [
  {
    title: 'Chấm công 4.0',
    subtitle: 'Attendance 4.0 - Smart & Secure',
    icon: 'qr_code_scanner',
    tone: 'primary',
    steps: [
      ['location_on', 'Geofencing', 'Hệ thống xác thực vị trí GPS trong bán kính văn phòng.'],
      ['qr_code_2', 'QR động', 'Mã tại Kiosk tự thay đổi để hạn chế sử dụng lại.'],
      ['bolt', 'Kiosk Mode', 'Quét QR tại thiết bị của văn phòng để chấm công nhanh.'],
    ],
  },
  {
    title: 'Số hóa đơn từ',
    subtitle: 'Seamless Request Management',
    icon: 'send',
    tone: 'info',
    steps: [
      ['event_available', 'Tạo đơn nhanh', 'Tạo đề xuất nghỉ phép, công tác hoặc làm việc tại nhà.'],
      ['edit', 'Giải trình công', 'Bổ sung thông tin khi dữ liệu chấm công có sai sót.'],
      ['notifications', 'Thông báo tức thì', 'Nhận phản hồi phê duyệt ngay trên điện thoại.'],
    ],
  },
  {
    title: 'Báo cáo thông minh',
    subtitle: 'Data-Driven Insights',
    icon: 'pie_chart',
    tone: 'success',
    steps: [
      ['speed', 'Dashboard', 'Xem nhanh công chuẩn, thực tế, ngày nghỉ và quỹ phép năm.'],
      ['history', 'Lịch sử chi tiết', 'Tra cứu dữ liệu vào, ra và vị trí đối soát.'],
      ['calendar_month', 'Theo dõi theo tháng', 'Kiểm tra tình trạng chấm công theo từng kỳ.'],
    ],
  },
  {
    title: 'An toàn & bảo mật',
    subtitle: 'Trusted Device Protocol',
    icon: 'shield',
    tone: 'danger',
    steps: [
      ['stay_primary_portrait', 'Thiết bị tin cậy', 'Mỗi tài khoản được định danh trên một thiết bị cá nhân.'],
      ['fingerprint', 'Chống giả mạo', 'QR động và GPS giúp giảm gian lận chấm công.'],
      ['key', 'Xác thực tài khoản', 'Thông tin cá nhân được bảo vệ bằng phiên đăng nhập Supabase.'],
    ],
  },
] as const;

export default function UserGuideModal({ isOpen, onClose }: Props) {
  const [activeTab, setActiveTab] = useState(0);

  const close = () => {
    triggerHaptic('medium');
    localStorage.setItem(STORAGE_KEYS.GUIDE_SEEN, 'true');
    onClose();
  };
  const dialogRef = useModalAccessibility(isOpen, close);

  if (!isOpen) return null;

  const section = GUIDE_SECTIONS[activeTab] ?? GUIDE_SECTIONS[0];
  const isLastSection = activeTab === GUIDE_SECTIONS.length - 1;

  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      className="app-guide-screen font-sans animate-slide-up"
      role="dialog"
      aria-modal="true"
      aria-labelledby="user-guide-title"
      aria-describedby="user-guide-subtitle"
    >
      <div className="guide-head">
        <span className={`ui-tile ui-tile-soft ui-tone-${section.tone} guide-head-icon`} aria-hidden="true">
          <span className="material-symbols-rounded">{section.icon}</span>
        </span>
        <div className="guide-head-text">
          <h2 id="user-guide-title">{section.title}</h2>
          <p id="user-guide-subtitle">{section.subtitle}</p>
        </div>
        <button type="button" onClick={close} className="ui-button ui-button-quiet guide-skip">Bỏ qua</button>
      </div>

      <div className="guide-body no-scrollbar">
        <section className="ui-card ui-card-flush">
          {section.steps.map(([icon, title, description]) => (
            <div key={title} className="ui-row">
              <span className={`ui-row-icon ui-tone-${section.tone}`} aria-hidden="true">
                <span className="material-symbols-rounded">{icon}</span>
              </span>
              <span className="ui-row-body">
                <span className="guide-step-title">{title}</span>
                <span className="guide-step-text">{description}</span>
              </span>
            </div>
          ))}
        </section>
      </div>

      <div className="guide-foot">
        <div className="ui-guide-dots">
          {GUIDE_SECTIONS.map((item, index) => (
            <button
              type="button"
              key={item.title}
              aria-label={`Mở phần ${index + 1}: ${item.title}`}
              aria-current={index === activeTab ? 'step' : undefined}
              onClick={() => setActiveTab(index)}
              className={`ui-guide-dot ${index === activeTab ? 'ui-guide-dot-active' : ''}`.trim()}
            />
          ))}
        </div>

        <div className="guide-nav">
          {activeTab > 0 ? (
            <button type="button" aria-label="Phần trước" onClick={() => setActiveTab((current) => current - 1)} className="ui-button ui-button-quiet guide-nav-back">
              <span className="material-symbols-rounded" aria-hidden="true">arrow_back</span>
            </button>
          ) : null}
          <button type="button" onClick={() => isLastSection ? close() : setActiveTab((current) => current + 1)} className="ui-cta">
            {isLastSection ? 'Bắt đầu dùng' : 'Tiếp theo'}
            <span className="material-symbols-rounded" aria-hidden="true">{isLastSection ? 'check' : 'arrow_forward'}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
