import { useRef, useState, type TouchEvent } from 'react';
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
    color: 'from-primary to-primary/80',
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
    color: 'from-secondary-purple to-secondary-purple/80',
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
    color: 'from-secondary-green to-secondary-green/80',
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
    color: 'from-secondary-red to-secondary-red/80',
    steps: [
      ['stay_primary_portrait', 'Thiết bị tin cậy', 'Mỗi tài khoản được định danh trên một thiết bị cá nhân.'],
      ['fingerprint', 'Chống giả mạo', 'QR động và GPS giúp giảm gian lận chấm công.'],
      ['key', 'Xác thực tài khoản', 'Thông tin cá nhân được bảo vệ bằng phiên đăng nhập Supabase.'],
    ],
  },
] as const;

export default function UserGuideModal({ isOpen, onClose }: Props) {
  const [activeTab, setActiveTab] = useState(0);
  const touchStartX = useRef<number | null>(null);

  const close = () => {
    triggerHaptic('medium');
    localStorage.setItem(STORAGE_KEYS.GUIDE_SEEN, 'true');
    onClose();
  };
  const dialogRef = useModalAccessibility(isOpen, close);

  if (!isOpen) return null;

  const section = GUIDE_SECTIONS[activeTab] ?? GUIDE_SECTIONS[0];
  const isLastSection = activeTab === GUIDE_SECTIONS.length - 1;

  const handleTouchEnd = (event: TouchEvent) => {
    if (touchStartX.current === null) return;
    const touch = event.changedTouches[0];
    if (!touch) return;
    const distance = touchStartX.current - touch.clientX;
    if (Math.abs(distance) > 50) {
      setActiveTab((current) => Math.max(0, Math.min(GUIDE_SECTIONS.length - 1, current + (distance > 0 ? 1 : -1))));
    }
    touchStartX.current = null;
  };

  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      className="app-guide-screen font-sans animate-slide-up"
      role="dialog"
      aria-modal="true"
      aria-labelledby="user-guide-title"
      aria-describedby="user-guide-subtitle"
      onTouchStart={(event) => { const touch=event.touches[0]; if(touch)touchStartX.current=touch.clientX; }}
      onTouchEnd={handleTouchEnd}
    >
      <button type="button" onClick={close} className="absolute top-safe mt-4 right-4 z-50 px-3 py-1.5 rounded-full bg-black/5 dark:bg-white/5 text-slate-500 dark:text-dark-text-secondary text-xxs font-bold uppercase tracking-widest">
        Đóng
      </button>

      <div className="pt-20 pb-8 px-8 text-center bg-slate-50 dark:bg-dark-surface">
        <div className={`w-28 h-28 mx-auto rounded-full bg-gradient-to-br ${section.color} text-white flex items-center justify-center shadow-xl`}>
          <span className="material-symbols-rounded text-6xl" aria-hidden="true">{section.icon}</span>
        </div>
        <h2 id="user-guide-title" className="text-2xl font-bold text-neutral-black dark:text-dark-text-primary mt-6">{section.title}</h2>
        <p id="user-guide-subtitle" className="app-wide-kicker text-xxs font-bold text-slate-400 uppercase mt-2">{section.subtitle}</p>
      </div>

      <div className="flex-1 px-8 py-8 overflow-y-auto">
        <div className="space-y-6">
          {section.steps.map(([icon, title, description]) => (
            <div key={title} className="flex items-start gap-5">
              <div className={`w-10 h-10 rounded-xl bg-gradient-to-br ${section.color} text-white flex items-center justify-center flex-shrink-0`}>
                <span className="material-symbols-rounded text-xl" aria-hidden="true">{icon}</span>
              </div>
              <div>
                <h4 className="text-base font-bold text-neutral-black dark:text-dark-text-primary">{title}</h4>
                <p className="text-xs font-medium text-slate-500 dark:text-dark-text-secondary leading-relaxed mt-1">{description}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="px-8 py-6 border-t border-slate-100 dark:border-dark-border">
        <div className="flex justify-center gap-2 mb-5">
          {GUIDE_SECTIONS.map((item, index) => (
            <button
              type="button"
              key={item.title}
              aria-label={`Mở phần ${index + 1}`}
              aria-current={index === activeTab ? 'step' : undefined}
              onClick={() => setActiveTab(index)}
              className={`h-1.5 rounded-full ${index === activeTab ? `w-8 bg-gradient-to-r ${section.color}` : 'w-1.5 bg-slate-200 dark:bg-dark-border'}`}
            />
          ))}
        </div>
        <div className="flex gap-3">
          {activeTab > 0 ? (
            <button type="button" aria-label="Phần trước" onClick={() => setActiveTab((current) => current - 1)} className="w-14 h-14 rounded-xl bg-slate-100 dark:bg-dark-border/50 flex items-center justify-center">
              <span className="material-symbols-rounded" aria-hidden="true">arrow_back</span>
            </button>
          ) : null}
          <button type="button" onClick={() => isLastSection ? close() : setActiveTab((current) => current + 1)} className={`flex-1 h-14 rounded-xl bg-gradient-to-r ${section.color} text-white font-bold uppercase tracking-widest flex items-center justify-center gap-2`}>
            {isLastSection ? 'Hoàn thành' : 'Tiếp theo'}
            <span className="material-symbols-rounded" aria-hidden="true">{isLastSection ? 'check' : 'chevron_right'}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
