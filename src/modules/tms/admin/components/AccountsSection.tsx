import { useMemo, useState, type FormEvent } from 'react';
import ConfirmDialog from '@/shared/components/modals/ConfirmDialog';
import Avatar from '@/shared/components/common/Avatar';
import { EMPLOYEE_ROLES, MANAGEMENT_ROLES, TMS_LIMITS } from '@/shared/constants';
import type { Employee, EmployeeRole } from '@/shared/types';
import { DEFAULT_EMPLOYEE } from '../constants';
import { deleteEmployeeAccount, resetEmployeeDevice, saveEmployee, type EmployeeInput } from '../adminService';
import { exportEmployeesExcel, parseEmployeesExcel } from '../adminExcel';
import type { AdminActionRunner, AdminData } from '../types';
import { formatDateTime } from '../formatters';
import { AdminSelect, EmptyState, Pagination, PanelTitle, SearchField, SpreadsheetActions } from './AdminCommon';

function createTemporaryPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%';
  const values = crypto.getRandomValues(new Uint32Array(TMS_LIMITS.TEMP_PASSWORD_LENGTH));
  return Array.from(values, (value) => alphabet[value % alphabet.length]).join('');
}

function validateEmployee(
  employee: EmployeeInput,
  mode: 'create' | 'update',
  hasAuthAccount: boolean,
  data: AdminData,
) {
  if (!/^[A-Z0-9_-]{2,40}$/.test(employee.employee_id.trim().toUpperCase())) {
    return 'Mã nhân viên cần từ 2–40 ký tự, chỉ gồm chữ, số, gạch ngang hoặc gạch dưới.';
  }
  if (!employee.name.trim()) return 'Vui lòng nhập họ tên nhân viên.';
  if (!/^\S+@\S+\.\S+$/.test(employee.email.trim())) return 'Email đăng nhập không đúng định dạng.';
  if (!EMPLOYEE_ROLES.includes(employee.role)) return 'Vai trò nhân viên không hợp lệ.';
  if (!data.locations.some((location) => location.center_id === employee.center_id)) return 'Vui lòng chọn địa điểm chính hợp lệ.';
  const locationIds = new Set(data.locations.map((location) => location.center_id));
  if ([...(employee.allowed_locations || []), ...(employee.managed_locations || [])].some((id) => !locationIds.has(id))) {
    return 'Danh sách địa điểm được gán có mục không còn tồn tại.';
  }
  if (employee.direct_manager_id === employee.employee_id) return 'Nhân viên không thể là quản lý trực tiếp của chính mình.';
  const annualLeave = Number(employee.annual_leave_balance);
  if (!Number.isFinite(annualLeave) || annualLeave < 0 || annualLeave > TMS_LIMITS.MAX_ANNUAL_LEAVE_DAYS) {
    return 'Số ngày phép còn lại không hợp lệ.';
  }
  const passwordRequired = mode === 'create' || (!hasAuthAccount && employee.status === 'Active');
  if (passwordRequired && (employee.password || '').length < TMS_LIMITS.ACCOUNT_PASSWORD_MIN_LENGTH) {
    return `Mật khẩu tạm phải có ít nhất ${TMS_LIMITS.ACCOUNT_PASSWORD_MIN_LENGTH} ký tự.`;
  }
  if (employee.password && employee.password.length < TMS_LIMITS.ACCOUNT_PASSWORD_MIN_LENGTH) {
    return `Mật khẩu mới phải có ít nhất ${TMS_LIMITS.ACCOUNT_PASSWORD_MIN_LENGTH} ký tự.`;
  }
  return null;
}

function LocationChecklist({
  title,
  locations,
  selected,
  onChange,
}: {
  title: string;
  locations: AdminData['locations'];
  selected: string[];
  onChange: (locations: string[]) => void;
}) {
  const toggle = (centerId: string, checked: boolean) => {
    onChange(checked ? [...new Set([...selected, centerId])] : selected.filter((id) => id !== centerId));
  };
  return (
    <fieldset className="admin-checklist">
      <legend>{title}</legend>
      <div>
        {locations.map((location) => (
          <label key={location.center_id}>
            <input
              type="checkbox"
              checked={selected.includes(location.center_id)}
              onChange={(event) => toggle(location.center_id, event.target.checked)}
            />
            <span>{location.center_name}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export default function AccountsSection({
  data,
  currentEmployeeId,
  busy,
  onRun,
}: {
  data: AdminData;
  currentEmployeeId: string;
  busy: boolean;
  onRun: AdminActionRunner;
}) {
  const [query, setQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState<'all' | EmployeeRole>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | Employee['status']>('all');
  const [page, setPage] = useState(1);
  const [mode, setMode] = useState<'create' | 'update'>('create');
  const [employee, setEmployee] = useState<EmployeeInput>({ ...DEFAULT_EMPLOYEE });
  const [editorOpen, setEditorOpen] = useState(false);
  const [hasAuthAccount, setHasAuthAccount] = useState(false);
  const [resetReason, setResetReason] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ employee_id: string; name: string } | null>(null);

  const filteredEmployees = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase('vi');
    return data.employees.filter((item) => {
      if (roleFilter !== 'all' && item.role !== roleFilter) return false;
      if (statusFilter !== 'all' && item.status !== statusFilter) return false;
      if (!normalizedQuery) return true;
      return [item.employee_id, item.name, item.email, item.department, item.position, item.center_id]
        .some((value) => String(value || '').toLocaleLowerCase('vi').includes(normalizedQuery));
    });
  }, [data.employees, query, roleFilter, statusFilter]);

  const pageCount = Math.ceil(filteredEmployees.length / TMS_LIMITS.ADMIN_TABLE_PAGE_SIZE);
  const safePage = Math.min(page, Math.max(pageCount, 1));
  const visibleEmployees = filteredEmployees.slice(
    (safePage - 1) * TMS_LIMITS.ADMIN_TABLE_PAGE_SIZE,
    safePage * TMS_LIMITS.ADMIN_TABLE_PAGE_SIZE,
  );
  const activeDevices = useMemo(() => new Map(data.devices.filter((device) => device.status === 'ACTIVE').map((device) => [device.employee_id, device])), [data.devices]);
  const activeDevice = activeDevices.get(employee.employee_id);
  const managers = data.employees.filter((item) => item.status === 'Active' && MANAGEMENT_ROLES.includes(item.role) && item.employee_id !== employee.employee_id);

  const startCreate = () => {
    const activeLocations = data.locations.filter((location) => location.active);
    const defaultCenterId = activeLocations.length === 1 ? activeLocations[0]?.center_id || '' : '';
    setMode('create');
    setHasAuthAccount(false);
    setEmployee({
      ...DEFAULT_EMPLOYEE,
      center_id: defaultCenterId,
      allowed_locations: defaultCenterId ? [defaultCenterId] : [],
      managed_locations: [],
    });
    setEditorOpen(true);
  };

  const startEdit = (item: Employee) => {
    setMode('update');
    setHasAuthAccount(Boolean(item.auth_user_id || item.uid));
    setEmployee({
      employee_id: item.employee_id,
      name: item.name,
      email: item.email,
      phone: String(item.phone || ''),
      role: item.role,
      center_id: item.center_id,
      allowed_locations: [...(item.allowed_locations || [])],
      managed_locations: [...(item.managed_locations || [])],
      direct_manager_id: item.direct_manager_id || null,
      annual_leave_balance: item.annual_leave_balance,
      attendance_policy_id: item.attendance_policy_id || null,
      position: item.position || '',
      department: item.department || '',
      status: item.status,
      password: '',
    });
    setEditorOpen(true);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const payload = {
      ...employee,
      employee_id: employee.employee_id.trim().toUpperCase(),
      name: employee.name.trim(),
      email: employee.email.trim().toLowerCase(),
    };
    const saved = await onRun(
      async () => {
        const validationError = validateEmployee(payload, mode, hasAuthAccount, data);
        if (validationError) throw new Error(validationError);
        return saveEmployee(payload, mode);
      },
      mode === 'create' ? 'Đã tạo tài khoản và hồ sơ nhân viên.' : 'Đã cập nhật tài khoản nhân viên.',
    );
    if (!saved) return;
    if (mode === 'create') {
      startCreate();
      return;
    }
    if (!hasAuthAccount && payload.password) setHasAuthAccount(true);
    setEmployee((current) => ({ ...current, password: '' }));
  };

  const confirmAccountDelete = async () => {
    if (!deleteTarget) return;
    const deleted = await onRun(
      () => deleteEmployeeAccount(deleteTarget.employee_id),
      `Đã xóa tài khoản đăng nhập của ${deleteTarget.name}; hồ sơ và dữ liệu chấm công được giữ lại.`,
    );
    if (deleted) {
      setDeleteTarget(null);
      setEditorOpen(false);
      setHasAuthAccount(false);
    }
  };

  const confirmDeviceReset = async () => {
    const reason = resetReason?.trim();
    if (!reason) return;
    setResetReason(null);
    await onRun(
      () => resetEmployeeDevice(employee.employee_id, reason),
      'Đã thu hồi thiết bị cũ. Nhân viên phải kích hoạt lại ở lần đăng nhập sau.',
    );
  };

  const importEmployees = async (file: File) => {
    await onRun(async () => {
      const imported = await parseEmployeesExcel(file, data);
      for (const item of imported) await saveEmployee(item.employee, item.mode);
    }, 'Đã nhập và đồng bộ dữ liệu nhân sự từ Excel.');
  };

  return (
    <>
      <div className={`admin-split-layout accounts-layout ${editorOpen ? 'editor-open' : 'editor-closed'}`}>
        <section className="admin-panel admin-list-panel">
          <PanelTitle
            eyebrow={`${data.employees.length} hồ sơ`}
            title="Tài khoản nhân viên"
            action={<div className="admin-panel-actions"><SpreadsheetActions disabled={busy} onExport={() => { void onRun(() => exportEmployeesExcel(filteredEmployees), 'Đã xuất danh sách nhân sự ra Excel.', { refresh: false }); }} onImport={importEmployees} /><button type="button" className="admin-primary-button" disabled={busy} onClick={startCreate}><span className="material-symbols-rounded">person_add</span>Thêm tài khoản</button></div>}
          />
          <div className="admin-filter-row">
            <SearchField value={query} onChange={(value) => { setQuery(value); setPage(1); }} placeholder="Tên, mã, email, phòng ban…" />
            <AdminSelect
              value={roleFilter}
              onChange={(value) => { setRoleFilter(value as typeof roleFilter); setPage(1); }}
              label="Lọc theo vai trò"
              options={[{ value: 'all', label: 'Mọi vai trò' }, ...EMPLOYEE_ROLES.map((role) => ({ value: role, label: role }))]}
            />
            <AdminSelect
              value={statusFilter}
              onChange={(value) => { setStatusFilter(value as typeof statusFilter); setPage(1); }}
              label="Lọc theo trạng thái"
              options={[
                { value: 'all', label: 'Mọi trạng thái' },
                { value: 'Active', label: 'Đang hoạt động' },
                { value: 'Inactive', label: 'Đã vô hiệu hóa' },
              ]}
            />
          </div>

          <div className="admin-account-table" role="table" aria-label="Danh sách tài khoản">
            <div className="admin-account-row admin-table-head" role="row">
              <span role="columnheader">Nhân viên</span><span role="columnheader">Vai trò</span><span role="columnheader">Chi nhánh</span><span role="columnheader">Thiết bị</span><span role="columnheader">Trạng thái</span>
            </div>
            {visibleEmployees.map((item) => {
              const device = activeDevices.get(item.employee_id);
              return (
                <button type="button" className={`admin-account-row ${editorOpen && employee.employee_id === item.employee_id ? 'selected' : ''}`} onClick={() => startEdit(item)} key={item.employee_id} role="row" aria-label={`Mở hồ sơ ${item.name}`}>
                  <span className="admin-account-person" data-label="Nhân viên"><Avatar src={item.avatar_url || item.face_ref_url} name={item.name} className="admin-avatar" textSize="" /><span><strong>{item.name}</strong><small>{item.employee_id} · {item.email}</small></span></span>
                  <span data-label="Vai trò">{item.role}</span>
                  <span data-label="Chi nhánh">{item.center_id || '—'}</span>
                  <span data-label="Thiết bị"><i className={`admin-dot ${device ? 'online' : ''}`} aria-hidden="true" />{item.role === 'Admin' ? 'Miễn khóa' : device ? 'Đã kích hoạt' : 'Chưa có'}</span>
                  <span data-label="Trạng thái"><b className={`admin-status account-${item.status.toLowerCase()}`}>{item.status === 'Active' ? 'Hoạt động' : item.auth_user_id || item.uid ? 'Tạm khóa' : 'Đã xóa đăng nhập'}</b></span>
                </button>
              );
            })}
            {!visibleEmployees.length ? <EmptyState icon="person_search" title="Không tìm thấy tài khoản phù hợp" /> : null}
          </div>
          <Pagination page={safePage} pageCount={pageCount} onChange={setPage} summary={`${filteredEmployees.length} tài khoản`} />
        </section>

        {editorOpen ? <form className="admin-panel admin-editor" onSubmit={(event) => void submit(event)}>
          <PanelTitle
            eyebrow="Supabase Auth + hồ sơ"
            title={mode === 'create' ? 'Tạo tài khoản' : `Chỉnh sửa ${employee.employee_id}`}
            action={<div className="admin-editor-heading-actions">{mode === 'update' ? <button type="button" className="admin-text-button" onClick={startCreate}>Tạo mới</button> : null}<button type="button" className="admin-icon-button" onClick={() => setEditorOpen(false)} aria-label="Đóng trình chỉnh sửa"><span className="material-symbols-rounded">close</span></button></div>}
          />

          <div className="admin-form-grid">
            <label><span>Mã nhân viên</span><input required disabled={mode === 'update'} value={employee.employee_id} onChange={(event) => setEmployee((current) => ({ ...current, employee_id: event.target.value.toUpperCase() }))} /></label>
            <label><span>Họ tên</span><input required value={employee.name} onChange={(event) => setEmployee((current) => ({ ...current, name: event.target.value }))} /></label>
            <label><span>Email đăng nhập</span><input required type="email" value={employee.email} onChange={(event) => setEmployee((current) => ({ ...current, email: event.target.value }))} /></label>
            <label><span>Số điện thoại</span><input type="tel" value={employee.phone || ''} onChange={(event) => setEmployee((current) => ({ ...current, phone: event.target.value }))} /></label>
            <div className="admin-field"><span>Vai trò</span><AdminSelect value={employee.role} onChange={(value) => setEmployee((current) => ({ ...current, role: value as EmployeeRole }))} label="Vai trò" options={EMPLOYEE_ROLES.map((role) => ({ value: role, label: role }))} /></div>
            <div className="admin-field"><span>Địa điểm chính</span><AdminSelect required value={employee.center_id} onChange={(value) => setEmployee((current) => ({ ...current, center_id: value }))} label="Địa điểm chính" placeholder="Chọn địa điểm" options={data.locations.map((location) => ({ value: location.center_id, label: location.center_name }))} /></div>
            <label><span>Chức danh</span><input value={employee.position || ''} onChange={(event) => setEmployee((current) => ({ ...current, position: event.target.value }))} /></label>
            <label><span>Phòng ban</span><input value={employee.department || ''} onChange={(event) => setEmployee((current) => ({ ...current, department: event.target.value }))} /></label>
            {employee.role !== 'Kiosk' ? (
              <>
                <div className="admin-field"><span>Quản lý trực tiếp</span><AdminSelect value={employee.direct_manager_id || ''} onChange={(value) => setEmployee((current) => ({ ...current, direct_manager_id: value || null }))} label="Quản lý trực tiếp" options={[{ value: '', label: 'Không gán' }, ...managers.map((manager) => ({ value: manager.employee_id, label: manager.name, description: manager.role }))]} /></div>
                <label><span>Số ngày phép còn lại</span><input type="number" min="0" max={TMS_LIMITS.MAX_ANNUAL_LEAVE_DAYS} step="0.5" value={employee.annual_leave_balance ?? 0} onChange={(event) => setEmployee((current) => ({ ...current, annual_leave_balance: Number(event.target.value) }))} /></label>
                <div className="admin-field admin-grid-span"><span>Chính sách chấm công</span><AdminSelect value={employee.attendance_policy_id || ''} onChange={(value) => setEmployee((current) => ({ ...current, attendance_policy_id: value || null }))} label="Chính sách chấm công" options={[{ value: '', label: 'Chưa gán chính sách' }, ...data.policies.filter((policy) => policy.active).map((policy) => ({ value: policy.id, label: policy.name }))]} /></div>
              </>
            ) : null}
          </div>

          <LocationChecklist title="Địa điểm được phép chấm công" locations={data.locations} selected={employee.allowed_locations || []} onChange={(allowedLocations) => setEmployee((current) => ({ ...current, allowed_locations: allowedLocations }))} />
          {MANAGEMENT_ROLES.includes(employee.role) ? <LocationChecklist title="Địa điểm được phép quản lý" locations={data.locations} selected={employee.managed_locations || []} onChange={(managedLocations) => setEmployee((current) => ({ ...current, managed_locations: managedLocations }))} /> : null}

          <div className="admin-password-field">
            <label><span>{mode === 'create' || !hasAuthAccount ? 'Mật khẩu tạm' : 'Mật khẩu mới (không bắt buộc)'}</span><input type="text" minLength={TMS_LIMITS.ACCOUNT_PASSWORD_MIN_LENGTH} required={mode === 'create' || (!hasAuthAccount && employee.status === 'Active')} autoComplete="new-password" value={employee.password || ''} onChange={(event) => setEmployee((current) => ({ ...current, password: event.target.value }))} /></label>
            <button type="button" className="admin-secondary-button" onClick={() => setEmployee((current) => ({ ...current, password: createTemporaryPassword() }))}>Tạo mật khẩu</button>
          </div>

          {mode === 'update' && employee.role !== 'Admin' ? (
            <section className="admin-device-card">
              <div><span className="material-symbols-rounded">devices</span><span><strong>Thiết bị tin cậy</strong><small>{activeDevice ? `${activeDevice.device_label || 'Thiết bị'} · gần nhất ${formatDateTime(activeDevice.last_seen_at)}` : 'Chưa có thiết bị đang hoạt động'}</small></span></div>
              {activeDevice ? <button type="button" onClick={() => setResetReason('')}>Thu hồi thiết bị</button> : null}
            </section>
          ) : null}

          <label className="admin-switch"><input type="checkbox" checked={employee.status === 'Active'} onChange={(event) => setEmployee((current) => ({ ...current, status: event.target.checked ? 'Active' : 'Inactive' }))} /><span><strong>Tài khoản hoạt động</strong><small>Tắt để vô hiệu hóa đăng nhập nhưng vẫn giữ dữ liệu lịch sử.</small></span></label>
          <footer className="admin-editor-actions admin-editor-actions-split">
            {mode === 'update' && hasAuthAccount && employee.employee_id !== currentEmployeeId ? <button type="button" className="admin-danger-button" disabled={busy} onClick={() => setDeleteTarget({ employee_id: employee.employee_id, name: employee.name })}><span className="material-symbols-rounded">person_remove</span>Xóa tài khoản</button> : null}
            <button type="submit" className="admin-primary-button" disabled={busy}><span className="material-symbols-rounded">save</span>{busy ? 'Đang lưu…' : hasAuthAccount || mode === 'create' ? 'Lưu tài khoản' : 'Tạo lại tài khoản'}</button>
          </footer>
        </form> : null}
      </div>

      <ConfirmDialog
        isOpen={resetReason !== null}
        title="Thu hồi thiết bị tin cậy?"
        message={<label className="admin-dialog-field"><span>Lý do bắt buộc</span><textarea value={resetReason || ''} onChange={(event) => setResetReason(event.target.value)} placeholder="Ví dụ: nhân viên đổi điện thoại" autoFocus /></label>}
        confirmLabel="Xác nhận thu hồi"
        onConfirm={() => void confirmDeviceReset()}
        onCancel={() => setResetReason(null)}
        isLoading={busy}
        type="warning"
      />
      <ConfirmDialog
        isOpen={deleteTarget !== null}
        title="Xóa tài khoản đăng nhập?"
        message={deleteTarget ? `Tài khoản của ${deleteTarget.name} sẽ bị xóa khỏi Supabase Auth và không thể đăng nhập. Hồ sơ nhân viên cùng toàn bộ lịch sử chấm công vẫn được giữ lại.` : ''}
        confirmLabel="Xóa tài khoản"
        onConfirm={() => void confirmAccountDelete()}
        onCancel={() => setDeleteTarget(null)}
        isLoading={busy}
        type="danger"
      />
    </>
  );
}
