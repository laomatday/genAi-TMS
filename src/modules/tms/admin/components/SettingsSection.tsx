import { useMemo, useState, type FormEvent } from 'react';
import {
  APPROVAL_CONFIG_KEY,
  APPROVAL_EDITABLE_ROLES,
  APPROVAL_KINDS,
  normalizeApprovalRoles,
  TMS_LIMITS,
  type ApprovalKind,
  type ApprovalRoleConfig,
} from '@/shared/constants';
import type { EmployeeRole, SystemConfig } from '@/shared/types';
import {
  DEFAULT_ATTENDANCE_POLICY,
  DEFAULT_HOLIDAY,
  DEFAULT_LOCATION,
  DEFAULT_SHIFT,
  DEFAULT_SYSTEM_SETTINGS,
  WEEKDAYS,
  type SettingsSection as SettingsTab,
} from '../constants';
import { saveAttendancePolicy, saveHoliday, saveShift, saveSystemSettings, saveTmsLocation } from '../adminService';
import type { AdminActionRunner, AdminData, AttendancePolicy, HolidayRecord, ShiftRecord, SystemSetting, TmsLocation } from '../types';
import { EmptyState, PanelTitle } from './AdminCommon';

const settingTabs: ReadonlyArray<{ id: SettingsTab; label: string; icon: string }> = [
  { id: 'system', label: 'Tham số hệ thống', icon: 'settings' },
  { id: 'policies', label: 'Chính sách công', icon: 'policy' },
  { id: 'shifts', label: 'Ca làm', icon: 'schedule' },
  { id: 'holidays', label: 'Ngày lễ', icon: 'event' },
  { id: 'locations', label: 'Địa điểm', icon: 'location_on' },
  { id: 'permissions', label: 'Phân quyền duyệt', icon: 'verified_user' },
];

const APPROVAL_KIND_LABELS: Record<ApprovalKind, { title: string; hint: string }> = {
  leave: { title: 'Duyệt yêu cầu nghỉ / công tác / WFH', hint: 'Nghỉ phép, nghỉ ốm, không lương, công tác, làm việc tại nhà.' },
  attendance: { title: 'Duyệt giải trình & điều chỉnh công', hint: 'Giải trình công thiếu, quên check-in/out, điều chỉnh giờ.' },
};

function getSystemConfig(settings: SystemSetting[]): SystemConfig {
  const settingMap = new Map(settings.map((setting) => [setting.key, setting.value]));
  const getSetting = (key: string, fallback: string) => settingMap.get(key) ?? fallback;
  const numberSetting = (key: string, fallback: number) => {
    const value = Number(getSetting(key, String(fallback)));
    return Number.isFinite(value) ? value : fallback;
  };
  return {
    LATE_TOLERANCE: numberSetting('LATE_TOLERANCE', DEFAULT_SYSTEM_SETTINGS.LATE_TOLERANCE),
    MIN_HOURS_FULL: numberSetting('MIN_HOURS_FULL', DEFAULT_SYSTEM_SETTINGS.MIN_HOURS_FULL),
    MIN_HOURS_HALF: numberSetting('MIN_HOURS_HALF', DEFAULT_SYSTEM_SETTINGS.MIN_HOURS_HALF),
    LUNCH_START: getSetting('LUNCH_START', DEFAULT_SYSTEM_SETTINGS.LUNCH_START),
    LUNCH_END: getSetting('LUNCH_END', DEFAULT_SYSTEM_SETTINGS.LUNCH_END),
    OFF_DAYS: getSetting('OFF_DAYS', DEFAULT_SYSTEM_SETTINGS.OFF_DAYS.join(',')).split(',').map(Number).filter(Number.isFinite),
    MAX_DISTANCE_METERS: numberSetting('MAX_DISTANCE_METERS', DEFAULT_SYSTEM_SETTINGS.MAX_DISTANCE_METERS),
    LOCK_DATE: numberSetting('LOCK_DATE', DEFAULT_SYSTEM_SETTINGS.LOCK_DATE || 5),
    MAX_EXPLANATIONS_PER_MONTH: numberSetting('MAX_EXPLANATIONS_PER_MONTH', DEFAULT_SYSTEM_SETTINGS.MAX_EXPLANATIONS_PER_MONTH || 5),
    QR_REFRESH_SECONDS: numberSetting('QR_REFRESH_SECONDS', DEFAULT_SYSTEM_SETTINGS.QR_REFRESH_SECONDS || TMS_LIMITS.QR_REFRESH_MS / 1_000),
    QR_VALIDITY_SECONDS: numberSetting('QR_VALIDITY_SECONDS', DEFAULT_SYSTEM_SETTINGS.QR_VALIDITY_SECONDS || TMS_LIMITS.QR_VALIDITY_SECONDS),
  };
}

function systemSettingsPayload(config: SystemConfig): SystemSetting[] {
  return [
    { key: 'LATE_TOLERANCE', value: String(config.LATE_TOLERANCE) },
    { key: 'MIN_HOURS_FULL', value: String(config.MIN_HOURS_FULL) },
    { key: 'MIN_HOURS_HALF', value: String(config.MIN_HOURS_HALF) },
    { key: 'LUNCH_START', value: config.LUNCH_START },
    { key: 'LUNCH_END', value: config.LUNCH_END },
    { key: 'OFF_DAYS', value: config.OFF_DAYS.join(',') },
    { key: 'MAX_DISTANCE_METERS', value: String(config.MAX_DISTANCE_METERS) },
    { key: 'LOCK_DATE', value: String(config.LOCK_DATE || 0) },
    { key: 'MAX_EXPLANATIONS_PER_MONTH', value: String(config.MAX_EXPLANATIONS_PER_MONTH || 5) },
    { key: 'QR_REFRESH_SECONDS', value: String(config.QR_REFRESH_SECONDS || 0) },
    { key: 'QR_VALIDITY_SECONDS', value: String(config.QR_VALIDITY_SECONDS || 0) },
  ];
}

function PoliciesSettings({ data, busy, onRun }: { data: AdminData; busy: boolean; onRun: AdminActionRunner }) {
  const [policy, setPolicy] = useState<AttendancePolicy>({ ...DEFAULT_ATTENDANCE_POLICY, work_days: [...DEFAULT_ATTENDANCE_POLICY.work_days] });
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    await onRun(() => saveAttendancePolicy(policy), 'Đã lưu chính sách chấm công.');
  };
  const toggleWorkday = (day: number, checked: boolean) => {
    setPolicy((current) => ({
      ...current,
      work_days: checked ? [...new Set([...current.work_days, day])].sort() : current.work_days.filter((item) => item !== day),
    }));
  };

  return (
    <div className="admin-split-layout settings-layout">
      <section className="admin-panel admin-list-panel">
        <PanelTitle eyebrow={`${data.policies.length} cấu hình`} title="Chính sách chấm công" />
        <div className="admin-config-list">
          {data.policies.map((item) => (
            <button type="button" className={policy.id === item.id ? 'selected' : ''} onClick={() => setPolicy({ ...item, work_days: [...item.work_days] })} key={item.id}>
              <span className="material-symbols-rounded">policy</span>
              <span><strong>{item.name}</strong><small>{item.expected_start.slice(0, 5)}–{item.expected_end.slice(0, 5)} · GPS ≤ {item.gps_max_accuracy_m}m</small></span>
              <b className={`admin-status account-${item.active ? 'active' : 'inactive'}`}>{item.active ? 'Đang dùng' : 'Tạm tắt'}</b>
            </button>
          ))}
          {!data.policies.length ? <EmptyState icon="policy" title="Chưa có chính sách" /> : null}
        </div>
      </section>

      <form className="admin-panel admin-editor" onSubmit={(event) => void submit(event)}>
        <PanelTitle eyebrow="Rule engine" title={policy.id ? 'Chỉnh sửa chính sách' : 'Tạo chính sách'} action={<button type="button" className="admin-text-button" onClick={() => setPolicy({ ...DEFAULT_ATTENDANCE_POLICY, work_days: [...DEFAULT_ATTENDANCE_POLICY.work_days] })}>Tạo mới</button>} />
        <div className="admin-form-grid">
          <label className="admin-grid-span"><span>Tên chính sách</span><input required value={policy.name} onChange={(event) => setPolicy((current) => ({ ...current, name: event.target.value }))} /></label>
          <label><span>Giờ bắt đầu</span><input type="time" value={policy.expected_start.slice(0, 5)} onChange={(event) => setPolicy((current) => ({ ...current, expected_start: event.target.value }))} /></label>
          <label><span>Giờ kết thúc</span><input type="time" value={policy.expected_end.slice(0, 5)} onChange={(event) => setPolicy((current) => ({ ...current, expected_end: event.target.value }))} /></label>
        </div>
        <fieldset className="admin-day-picker"><legend>Ngày làm việc</legend><div>{WEEKDAYS.map((day) => <label className={policy.work_days.includes(day.value) ? 'checked' : ''} key={day.value}><input type="checkbox" checked={policy.work_days.includes(day.value)} onChange={(event) => toggleWorkday(day.value, event.target.checked)} /><span>{day.label}</span></label>)}</div></fieldset>
        <div className="admin-form-grid">
          <label><span>Cho phép trễ (phút)</span><input type="number" min="0" max="180" value={policy.late_tolerance_minutes} onChange={(event) => setPolicy((current) => ({ ...current, late_tolerance_minutes: Number(event.target.value) }))} /></label>
          <label><span>Cho phép về sớm (phút)</span><input type="number" min="0" max="180" value={policy.early_tolerance_minutes} onChange={(event) => setPolicy((current) => ({ ...current, early_tolerance_minutes: Number(event.target.value) }))} /></label>
          <label><span>Check-in từ</span><input type="time" value={policy.checkin_window_start.slice(0, 5)} onChange={(event) => setPolicy((current) => ({ ...current, checkin_window_start: event.target.value }))} /></label>
          <label><span>Check-in đến</span><input type="time" value={policy.checkin_window_end.slice(0, 5)} onChange={(event) => setPolicy((current) => ({ ...current, checkin_window_end: event.target.value }))} /></label>
          <label><span>Check-out từ</span><input type="time" value={policy.checkout_window_start.slice(0, 5)} onChange={(event) => setPolicy((current) => ({ ...current, checkout_window_start: event.target.value }))} /></label>
          <label><span>Check-out đến</span><input type="time" value={policy.checkout_window_end.slice(0, 5)} onChange={(event) => setPolicy((current) => ({ ...current, checkout_window_end: event.target.value }))} /></label>
          <label><span>GPS tốt tối đa (m)</span><input type="number" min="5" max="500" value={policy.gps_good_accuracy_m} onChange={(event) => setPolicy((current) => ({ ...current, gps_good_accuracy_m: Number(event.target.value) }))} /></label>
          <label><span>GPS chấp nhận (m)</span><input type="number" min="10" max="1000" value={policy.gps_max_accuracy_m} onChange={(event) => setPolicy((current) => ({ ...current, gps_max_accuracy_m: Number(event.target.value) }))} /></label>
          <label className="admin-grid-span"><span>Trừ nghỉ giữa ca (phút)</span><input type="number" min="0" max="360" value={policy.unpaid_break_minutes} onChange={(event) => setPolicy((current) => ({ ...current, unpaid_break_minutes: Number(event.target.value) }))} /></label>
        </div>
        <label className="admin-switch"><input type="checkbox" checked={policy.auto_approve} onChange={(event) => setPolicy((current) => ({ ...current, auto_approve: event.target.checked }))} /><span><strong>Tự động duyệt ngày công hợp lệ</strong><small>Ngày không có ngoại lệ sẽ không vào hàng chờ.</small></span></label>
        <label className="admin-switch"><input type="checkbox" checked={policy.active} onChange={(event) => setPolicy((current) => ({ ...current, active: event.target.checked }))} /><span><strong>Chính sách đang hoạt động</strong><small>Chỉ chính sách đang hoạt động mới có thể gán cho nhân viên.</small></span></label>
        <footer className="admin-editor-actions"><button className="admin-primary-button" disabled={busy}><span className="material-symbols-rounded">save</span>Lưu chính sách</button></footer>
      </form>
    </div>
  );
}

function ShiftsSettings({ data, busy, onRun }: { data: AdminData; busy: boolean; onRun: AdminActionRunner }) {
  const [shift, setShift] = useState<ShiftRecord>({ ...DEFAULT_SHIFT });
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    await onRun(() => saveShift(shift), 'Đã lưu cấu hình ca làm.');
  };
  return (
    <div className="admin-split-layout settings-layout">
      <section className="admin-panel admin-list-panel"><PanelTitle eyebrow={`${data.shifts.length} ca`} title="Danh sách ca làm" /><div className="admin-config-list">{data.shifts.map((item) => <button type="button" className={shift.id === item.id ? 'selected' : ''} onClick={() => setShift({ ...item })} key={item.id}><span className="material-symbols-rounded">schedule</span><span><strong>{item.name}</strong><small>{item.start_time.slice(0, 5)}–{item.end_time.slice(0, 5)} · thứ tự {item.sort_order}</small></span><b className={`admin-status account-${item.active ? 'active' : 'inactive'}`}>{item.active ? 'Bật' : 'Tắt'}</b></button>)}{!data.shifts.length ? <EmptyState icon="schedule" title="Chưa có ca làm" description="Tạo ca đầu tiên để bắt đầu lập lịch cho nhân viên." /> : null}</div></section>
      <form className="admin-panel admin-editor" onSubmit={(event) => void submit(event)}><PanelTitle eyebrow="Khung giờ vận hành" title={shift.id ? 'Chỉnh sửa ca' : 'Tạo ca làm'} action={<button type="button" className="admin-text-button" onClick={() => setShift({ ...DEFAULT_SHIFT })}>Tạo mới</button>} /><div className="admin-form-grid"><label className="admin-grid-span"><span>Tên ca</span><input required value={shift.name} onChange={(event) => setShift((current) => ({ ...current, name: event.target.value }))} /></label><label><span>Bắt đầu</span><input type="time" value={shift.start_time.slice(0, 5)} onChange={(event) => setShift((current) => ({ ...current, start_time: event.target.value }))} /></label><label><span>Kết thúc</span><input type="time" value={shift.end_time.slice(0, 5)} onChange={(event) => setShift((current) => ({ ...current, end_time: event.target.value }))} /></label><label><span>Mốc phân ca</span><input type="time" value={shift.break_point.slice(0, 5)} onChange={(event) => setShift((current) => ({ ...current, break_point: event.target.value }))} /></label><label><span>Thứ tự</span><input type="number" value={shift.sort_order} onChange={(event) => setShift((current) => ({ ...current, sort_order: Number(event.target.value) }))} /></label></div><label className="admin-switch"><input type="checkbox" checked={shift.active} onChange={(event) => setShift((current) => ({ ...current, active: event.target.checked }))} /><span><strong>Ca đang hoạt động</strong><small>Ca tắt vẫn được giữ cho dữ liệu lịch sử.</small></span></label><footer className="admin-editor-actions"><button className="admin-primary-button" disabled={busy}><span className="material-symbols-rounded">save</span>Lưu ca làm</button></footer></form>
    </div>
  );
}

function SystemSettings({ data, busy, onRun }: { data: AdminData; busy: boolean; onRun: AdminActionRunner }) {
  const [config, setConfig] = useState<SystemConfig>(() => getSystemConfig(data.systemSettings));
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    await onRun(async () => {
      if ((config.QR_REFRESH_SECONDS || 0) >= (config.QR_VALIDITY_SECONDS || 0)) throw new Error('Thời gian hiệu lực QR phải lớn hơn chu kỳ làm mới.');
      await saveSystemSettings(systemSettingsPayload(config));
    }, 'Đã lưu tham số hệ thống.');
  };
  const toggleOffDay = (day: number, checked: boolean) => setConfig((current) => ({ ...current, OFF_DAYS: checked ? [...new Set([...current.OFF_DAYS, day])].sort() : current.OFF_DAYS.filter((item) => item !== day) }));
  return (
    <form className="admin-panel admin-system-form" onSubmit={(event) => void submit(event)}>
      <PanelTitle eyebrow="Cấu hình dùng chung" title="Tham số hệ thống" />
      <div className="admin-setting-groups">
        <fieldset>
          <legend>Quy định giải trình & Khóa công</legend>
          <div className="admin-form-grid">
            <label>
              <span>Số giải trình tối đa / tháng</span>
              <input
                type="number"
                min="1"
                max="50"
                value={config.MAX_EXPLANATIONS_PER_MONTH || 5}
                onChange={(event) => setConfig((current) => ({ ...current, MAX_EXPLANATIONS_PER_MONTH: Number(event.target.value) }))}
              />
              <small style={{ color: 'var(--admin-faint, #64748b)', fontSize: '12px', marginTop: '2px', lineHeight: 1.4 }}>
                Hạn mức tối đa mỗi nhân viên được gửi giải trình trong 1 tháng (ví dụ: 3, 5, 10 đơn).
              </small>
            </label>
            <label>
              <span>Hạn giải trình tháng sau (ngày chốt)</span>
              <input
                type="number"
                min="1"
                max="31"
                value={config.LOCK_DATE || 1}
                onChange={(event) => setConfig((current) => ({ ...current, LOCK_DATE: Number(event.target.value) }))}
              />
              <small style={{ color: 'var(--admin-faint, #64748b)', fontSize: '12px', marginTop: '2px', lineHeight: 1.4 }}>
                Hạn chót trong tháng hiện tại để gửi giải trình cho công tháng trước (mặc định ngày 5).
              </small>
            </label>
          </div>
        </fieldset>

        <fieldset>
          <legend>Quy đổi ngày công tiêu chuẩn</legend>
          <div className="admin-form-grid">
            <label><span>Đủ một ngày (giờ)</span><input type="number" min="1" max="24" step="0.5" value={config.MIN_HOURS_FULL} onChange={(event) => setConfig((current) => ({ ...current, MIN_HOURS_FULL: Number(event.target.value) }))} /></label>
            <label><span>Đủ nửa ngày (giờ)</span><input type="number" min="0.5" max="12" step="0.5" value={config.MIN_HOURS_HALF} onChange={(event) => setConfig((current) => ({ ...current, MIN_HOURS_HALF: Number(event.target.value) }))} /></label>
            <label className="admin-grid-span"><span>Ngưỡng trễ cũ (phút)</span><input type="number" min="0" max="180" value={config.LATE_TOLERANCE} onChange={(event) => setConfig((current) => ({ ...current, LATE_TOLERANCE: Number(event.target.value) }))} /></label>
          </div>
        </fieldset>

        <fieldset><legend>Nghỉ trưa và ngày nghỉ</legend><div className="admin-form-grid"><label><span>Bắt đầu nghỉ trưa</span><input type="time" value={config.LUNCH_START} onChange={(event) => setConfig((current) => ({ ...current, LUNCH_START: event.target.value }))} /></label><label><span>Kết thúc nghỉ trưa</span><input type="time" value={config.LUNCH_END} onChange={(event) => setConfig((current) => ({ ...current, LUNCH_END: event.target.value }))} /></label></div><div className="admin-day-picker compact"><span>Ngày nghỉ mặc định</span><div>{[{ value: 0, label: 'CN' }, { value: 1, label: 'T2' }, { value: 2, label: 'T3' }, { value: 3, label: 'T4' }, { value: 4, label: 'T5' }, { value: 5, label: 'T6' }, { value: 6, label: 'T7' }].map((day) => <label className={config.OFF_DAYS.includes(day.value) ? 'checked' : ''} key={day.value}><input type="checkbox" checked={config.OFF_DAYS.includes(day.value)} onChange={(event) => toggleOffDay(day.value, event.target.checked)} /><span>{day.label}</span></label>)}</div></div></fieldset>
        <fieldset><legend>GPS và QR</legend><div className="admin-form-grid"><label><span>Bán kính mặc định (m)</span><input type="number" min="20" max="1000" value={config.MAX_DISTANCE_METERS} onChange={(event) => setConfig((current) => ({ ...current, MAX_DISTANCE_METERS: Number(event.target.value) }))} /></label><label><span>QR làm mới sau (giây)</span><input type="number" min={TMS_LIMITS.QR_REFRESH_MIN_SECONDS} max={TMS_LIMITS.QR_REFRESH_MAX_SECONDS} value={config.QR_REFRESH_SECONDS} onChange={(event) => setConfig((current) => ({ ...current, QR_REFRESH_SECONDS: Number(event.target.value) }))} /></label><label><span>QR hiệu lực (giây)</span><input type="number" min={TMS_LIMITS.QR_VALIDITY_MIN_SECONDS} max={TMS_LIMITS.QR_VALIDITY_MAX_SECONDS} value={config.QR_VALIDITY_SECONDS} onChange={(event) => setConfig((current) => ({ ...current, QR_VALIDITY_SECONDS: Number(event.target.value) }))} /></label></div><p className="admin-help-text">Hiệu lực QR phải dài hơn chu kỳ làm mới để nhân viên không quét trúng khoảng trống.</p></fieldset>
      </div>
      <footer className="admin-editor-actions"><button className="admin-primary-button" disabled={busy}><span className="material-symbols-rounded">save</span>Lưu tham số</button></footer>
    </form>
  );
}

function PermissionsSettings({ data, busy, onRun }: { data: AdminData; busy: boolean; onRun: AdminActionRunner }) {
  const stored = useMemo(
    () => normalizeApprovalRoles(data.systemSettings.find((setting) => setting.key === APPROVAL_CONFIG_KEY)?.value ?? null),
    [data.systemSettings],
  );
  const [config, setConfig] = useState<ApprovalRoleConfig>(stored);

  const toggle = (kind: ApprovalKind, role: EmployeeRole, checked: boolean) => {
    setConfig((current) => ({
      ...current,
      [kind]: checked
        ? [...new Set<EmployeeRole>([...current[kind], role])]
        : current[kind].filter((item) => item !== role),
    }));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const payloadValue = JSON.stringify({
      leave: config.leave.filter((role) => role !== 'Admin'),
      attendance: config.attendance.filter((role) => role !== 'Admin'),
    });
    await onRun(
      () => saveSystemSettings([{ key: APPROVAL_CONFIG_KEY, value: payloadValue }]),
      'Đã lưu phân quyền duyệt.',
    );
  };

  return (
    <form className="admin-panel admin-system-form" onSubmit={(event) => void submit(event)}>
      <PanelTitle eyebrow="Quyền duyệt yêu cầu" title="Phân quyền duyệt" />
      <p className="admin-help-text">
        Chọn vai trò được phép duyệt / từ chối từng loại yêu cầu. <strong>Admin</strong> luôn có quyền.
        Vai trò không được chọn sẽ không thấy mục duyệt trong ứng dụng.
      </p>
      <div className="admin-setting-groups">
        {APPROVAL_KINDS.map((kind) => (
          <fieldset key={kind}>
            <legend>{APPROVAL_KIND_LABELS[kind].title}</legend>
            <p className="admin-help-text">{APPROVAL_KIND_LABELS[kind].hint}</p>
            {APPROVAL_EDITABLE_ROLES.map((role) => (
              <label className="admin-switch" key={role}>
                <input
                  type="checkbox"
                  checked={config[kind].includes(role)}
                  onChange={(event) => toggle(kind, role, event.target.checked)}
                />
                <span><strong>{role}</strong></span>
              </label>
            ))}
            <label className="admin-switch" aria-disabled="true">
              <input type="checkbox" checked disabled />
              <span><strong>Admin</strong><small>Luôn được duyệt</small></span>
            </label>
          </fieldset>
        ))}
      </div>
      <footer className="admin-editor-actions">
        <button className="admin-primary-button" disabled={busy}><span className="material-symbols-rounded">save</span>Lưu phân quyền</button>
      </footer>
    </form>
  );
}

function HolidaysSettings({ data, busy, onRun }: { data: AdminData; busy: boolean; onRun: AdminActionRunner }) {
  const [holiday, setHoliday] = useState<HolidayRecord>({ ...DEFAULT_HOLIDAY });
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    await onRun(() => saveHoliday(holiday), 'Đã lưu ngày nghỉ lễ.');
  };
  return (
    <div className="admin-split-layout settings-layout"><section className="admin-panel admin-list-panel"><PanelTitle eyebrow={`${data.holidays.length} kỳ nghỉ`} title="Lịch nghỉ lễ" /><div className="admin-config-list">{data.holidays.map((item) => <button type="button" className={holiday.id === item.id ? 'selected' : ''} onClick={() => setHoliday({ ...item })} key={item.id}><span className="material-symbols-rounded">event</span><span><strong>{item.name}</strong><small>{item.from_date} → {item.to_date} · {item.paid ? 'Có lương' : 'Không lương'}</small></span><b className={`admin-status account-${item.active ? 'active' : 'inactive'}`}>{item.active ? 'Bật' : 'Tắt'}</b></button>)}{!data.holidays.length ? <EmptyState icon="event_busy" title="Chưa có ngày nghỉ lễ" description="Thêm lịch nghỉ để bảng công áp dụng đúng chính sách." /> : null}</div></section><form className="admin-panel admin-editor" onSubmit={(event) => void submit(event)}><PanelTitle eyebrow="Lịch doanh nghiệp" title={holiday.id ? 'Chỉnh sửa ngày lễ' : 'Thêm ngày lễ'} action={<button type="button" className="admin-text-button" onClick={() => setHoliday({ ...DEFAULT_HOLIDAY })}>Tạo mới</button>} /><div className="admin-form-grid"><label className="admin-grid-span"><span>Tên ngày lễ</span><input required value={holiday.name} onChange={(event) => setHoliday((current) => ({ ...current, name: event.target.value }))} /></label><label><span>Từ ngày</span><input required type="date" value={holiday.from_date} onChange={(event) => setHoliday((current) => ({ ...current, from_date: event.target.value }))} /></label><label><span>Đến ngày</span><input required type="date" min={holiday.from_date} value={holiday.to_date} onChange={(event) => setHoliday((current) => ({ ...current, to_date: event.target.value }))} /></label></div><label className="admin-switch"><input type="checkbox" checked={holiday.paid} onChange={(event) => setHoliday((current) => ({ ...current, paid: event.target.checked }))} /><span><strong>Nghỉ hưởng lương</strong><small>Được tính vào lịch công tiêu chuẩn.</small></span></label><label className="admin-switch"><input type="checkbox" checked={holiday.active} onChange={(event) => setHoliday((current) => ({ ...current, active: event.target.checked }))} /><span><strong>Đang áp dụng</strong><small>Tắt để giữ lịch sử nhưng không áp dụng.</small></span></label><footer className="admin-editor-actions"><button className="admin-primary-button" disabled={busy}><span className="material-symbols-rounded">save</span>Lưu ngày lễ</button></footer></form></div>
  );
}

function LocationsSettings({ data, busy, onRun }: { data: AdminData; busy: boolean; onRun: AdminActionRunner }) {
  const [location, setLocation] = useState<TmsLocation>({ ...DEFAULT_LOCATION });
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    await onRun(() => saveTmsLocation(location), 'Đã lưu địa điểm và geofence.');
  };
  const captureGps = () => void onRun(() => new Promise<void>((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Thiết bị không hỗ trợ định vị.'));
      return;
    }
    navigator.geolocation.getCurrentPosition((position) => {
      setLocation((current) => ({
        ...current,
        latitude: Number(position.coords.latitude.toFixed(7)),
        longitude: Number(position.coords.longitude.toFixed(7)),
      }));
      resolve();
    }, () => reject(new Error('Không lấy được vị trí hiện tại. Hãy kiểm tra quyền GPS.')), {
      enableHighAccuracy: true,
      timeout: TMS_LIMITS.GPS_TIMEOUT_MS,
    });
  }), 'Đã lấy tọa độ hiện tại.');
  return (
    <div className="admin-split-layout settings-layout"><section className="admin-panel admin-list-panel"><PanelTitle eyebrow={`${data.locations.length} địa điểm`} title="Geofence chấm công" /><div className="admin-config-list">{data.locations.map((item) => <button type="button" className={location.center_id === item.center_id ? 'selected' : ''} onClick={() => setLocation({ ...item })} key={item.center_id}><span className="material-symbols-rounded">location_on</span><span><strong>{item.center_name}</strong><small>{item.address || item.center_id}</small></span><b>{item.radius_meters}m</b></button>)}{!data.locations.length ? <EmptyState icon="location_off" title="Chưa có địa điểm" description="Tạo geofence đầu tiên để mở chấm công GPS và Kiosk." /> : null}</div></section><form className="admin-panel admin-editor" onSubmit={(event) => void submit(event)}><PanelTitle eyebrow="GPS boundary" title={location.center_id ? 'Chỉnh sửa địa điểm' : 'Thêm địa điểm'} action={<button type="button" className="admin-text-button" onClick={() => setLocation({ ...DEFAULT_LOCATION })}>Tạo mới</button>} /><div className="admin-form-grid"><label><span>Mã địa điểm</span><input required disabled={data.locations.some((item) => item.center_id === location.center_id)} value={location.center_id} onChange={(event) => setLocation((current) => ({ ...current, center_id: event.target.value.toUpperCase() }))} /></label><label><span>Tên địa điểm</span><input required value={location.center_name} onChange={(event) => setLocation((current) => ({ ...current, center_name: event.target.value }))} /></label><label className="admin-grid-span"><span>Địa chỉ</span><input value={location.address || ''} onChange={(event) => setLocation((current) => ({ ...current, address: event.target.value }))} /></label><label><span>Tỉnh / thành phố</span><input value={location.city || ''} onChange={(event) => setLocation((current) => ({ ...current, city: event.target.value }))} /></label><label><span>Bán kính (m)</span><input type="number" min="20" max="1000" value={location.radius_meters} onChange={(event) => setLocation((current) => ({ ...current, radius_meters: Number(event.target.value) }))} /></label><label><span>Latitude</span><input type="number" step="any" min="-90" max="90" value={location.latitude} onChange={(event) => setLocation((current) => ({ ...current, latitude: Number(event.target.value) }))} /></label><label><span>Longitude</span><input type="number" step="any" min="-180" max="180" value={location.longitude} onChange={(event) => setLocation((current) => ({ ...current, longitude: Number(event.target.value) }))} /></label></div><button type="button" className="admin-secondary-button admin-location-button" disabled={busy} onClick={captureGps}><span className="material-symbols-rounded">my_location</span>Lấy tọa độ hiện tại</button><label className="admin-switch"><input type="checkbox" checked={location.active} onChange={(event) => setLocation((current) => ({ ...current, active: event.target.checked }))} /><span><strong>Địa điểm đang hoạt động</strong><small>Chỉ địa điểm hoạt động mới mở được trạm QR.</small></span></label><footer className="admin-editor-actions"><button className="admin-primary-button" disabled={busy}><span className="material-symbols-rounded">save</span>Lưu địa điểm</button></footer></form></div>
  );
}

export default function SettingsSection({ data, busy, onRun }: { data: AdminData; busy: boolean; onRun: AdminActionRunner }) {
  const [section, setSection] = useState<SettingsTab>('system');
  return (
    <div className="admin-section-stack">
      <nav className="admin-tabs admin-settings-tabs" aria-label="Nhóm tham số" role="tablist">
        {settingTabs.map((tab) => <button type="button" role="tab" aria-selected={section === tab.id} className={section === tab.id ? 'active' : ''} onClick={() => setSection(tab.id)} key={tab.id}><span className="material-symbols-rounded" aria-hidden="true">{tab.icon}</span>{tab.label}</button>)}
      </nav>
      {section === 'policies' ? <PoliciesSettings data={data} busy={busy} onRun={onRun} /> : null}
      {section === 'shifts' ? <ShiftsSettings data={data} busy={busy} onRun={onRun} /> : null}
      {section === 'system' ? <SystemSettings data={data} busy={busy} onRun={onRun} /> : null}
      {section === 'holidays' ? <HolidaysSettings data={data} busy={busy} onRun={onRun} /> : null}
      {section === 'locations' ? <LocationsSettings data={data} busy={busy} onRun={onRun} /> : null}
      {section === 'permissions' ? <PermissionsSettings data={data} busy={busy} onRun={onRun} /> : null}
    </div>
  );
}
