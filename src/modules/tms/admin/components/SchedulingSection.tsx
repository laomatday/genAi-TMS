import { useEffect, useMemo, useState } from 'react';
import ConfirmDialog from '@/shared/components/modals/ConfirmDialog';
import { toISODateString } from '@/core/utils/helpers';
import { deleteShiftAssignment, saveShiftAssignments } from '../adminService';
import { exportShiftAssignmentsExcel, parseShiftAssignmentsExcel } from '../adminExcel';
import type { AdminActionRunner, AdminData, ShiftAssignment } from '../types';
import { AdminSelect, EmptyState, PanelTitle, SearchField, SpreadsheetActions } from './AdminCommon';

const dayFormatter = new Intl.DateTimeFormat('vi-VN', { weekday: 'short', day: '2-digit', month: '2-digit' });

function parseDate(value: string) {
  return new Date(`${value}T12:00:00`);
}

function addDays(value: string, days: number) {
  const date = parseDate(value);
  date.setDate(date.getDate() + days);
  return toISODateString(date);
}

function mondayOf(value: string) {
  const date = parseDate(value);
  const day = date.getDay() || 7;
  date.setDate(date.getDate() - day + 1);
  return toISODateString(date);
}

function displayTime(value: string) {
  return value.slice(0, 5);
}

export default function SchedulingSection({
  data,
  month,
  onMonthChange,
  busy,
  onRun,
}: {
  data: AdminData;
  month: string;
  onMonthChange: (month: string) => void;
  busy: boolean;
  onRun: AdminActionRunner;
}) {
  const today = toISODateString(new Date());
  const [weekStart, setWeekStart] = useState(() => mondayOf(today));
  const [workDate, setWorkDate] = useState(today);
  const [query, setQuery] = useState('');
  const [center, setCenter] = useState('all');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [shiftId, setShiftId] = useState(() => String(data.shifts.find((shift) => shift.active)?.id || ''));
  const [locationId, setLocationId] = useState('');
  const [note, setNote] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<ShiftAssignment | null>(null);
  const weekDays = useMemo(() => Array.from({ length: 7 }, (_, index) => addDays(weekStart, index)), [weekStart]);
  const activeEmployees = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase('vi');
    return data.employees.filter((employee) => {
      if (employee.status !== 'Active' || employee.role === 'Kiosk') return false;
      if (center !== 'all' && employee.center_id !== center) return false;
      if (!normalizedQuery) return true;
      return [employee.name, employee.employee_id, employee.department, employee.position]
        .some((value) => String(value || '').toLocaleLowerCase('vi').includes(normalizedQuery));
    });
  }, [center, data.employees, query]);
  const assignments = useMemo(
    () => new Map(data.shiftAssignments.map((assignment) => [`${assignment.employee_id}:${assignment.work_date}`, assignment])),
    [data.shiftAssignments],
  );
  const shifts = useMemo(() => new Map(data.shifts.map((shift) => [shift.id, shift])), [data.shifts]);

  useEffect(() => {
    const displayedMonth = addDays(weekStart, 3).slice(0, 7);
    if (displayedMonth === month) return;
    const anchor = month === today.slice(0, 7) ? today : `${month}-15`;
    setWeekStart(mondayOf(anchor));
    if (anchor >= today) setWorkDate(anchor);
  }, [month, today, weekStart]);

  const setWeek = (nextWeek: string) => {
    setWeekStart(nextWeek);
    const middleDay = addDays(nextWeek, 3);
    if (middleDay.slice(0, 7) !== month) onMonthChange(middleDay.slice(0, 7));
  };

  const toggleEmployee = (employeeId: string, checked: boolean) => {
    setSelectedIds((current) => checked
      ? [...new Set([...current, employeeId])]
      : current.filter((id) => id !== employeeId));
  };

  const selectAssignment = (assignment: ShiftAssignment) => {
    setSelectedIds([assignment.employee_id]);
    setWorkDate(assignment.work_date);
    setShiftId(String(assignment.shift_id));
    setLocationId(assignment.location_id || '');
    setNote(assignment.note || '');
  };

  const save = async () => {
    const selectedShift = Number(shiftId);
    if (!selectedIds.length || !workDate || !selectedShift) return;
    await onRun(
      () => saveShiftAssignments(selectedIds.map((employeeId) => ({
        employee_id: employeeId,
        work_date: workDate,
        shift_id: selectedShift,
        location_id: locationId || null,
        note,
      }))),
      `Đã phân ca cho ${selectedIds.length} nhân viên.`,
    );
    setSelectedIds([]);
    setNote('');
  };

  const remove = async () => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleteTarget(null);
    await onRun(
      () => deleteShiftAssignment(target.id, 'Xóa từ lịch phân ca'),
      'Đã xóa lịch phân ca.',
    );
  };

  const importAssignments = async (file: File) => {
    await onRun(async () => {
      const imported = await parseShiftAssignmentsExcel(file, data, month);
      await saveShiftAssignments(imported);
    }, `Đã nhập lịch phân ca tháng ${month} từ Excel.`);
  };

  if (!data.features.workforceOperations) {
    return (
      <section className="admin-panel">
        <EmptyState
          icon="calendar_clock"
          title="Module phân ca đang chờ kích hoạt"
          description="Áp dụng migration workforce_operations lên Supabase để bắt đầu lập lịch và đóng kỳ công."
        />
      </section>
    );
  }

  return (
    <div className="admin-section-stack">
      <section className="admin-panel schedule-compose-panel">
        <PanelTitle eyebrow="Lập lịch theo nhóm" title="Phân ca nhanh" />
        <div className="schedule-compose-grid">
          <label><span>Ngày làm việc</span><input type="date" min={today} value={workDate} onChange={(event) => setWorkDate(event.target.value)} /></label>
          <div className="admin-field"><span>Ca làm</span><AdminSelect value={shiftId} onChange={setShiftId} label="Ca làm" placeholder="Chọn ca" options={data.shifts.filter((shift) => shift.active).map((shift) => ({ value: String(shift.id), label: shift.name, description: `${displayTime(shift.start_time)}–${displayTime(shift.end_time)}` }))} /></div>
          <div className="admin-field"><span>Địa điểm</span><AdminSelect value={locationId} onChange={setLocationId} label="Địa điểm" options={[{ value: '', label: 'Theo hồ sơ nhân viên' }, ...data.locations.filter((location) => location.active).map((location) => ({ value: location.center_id, label: location.center_name }))]} /></div>
          <label className="schedule-note"><span>Ghi chú</span><input maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Không bắt buộc" /></label>
          <button type="button" className="admin-primary-button" disabled={busy || !selectedIds.length || !shiftId || !workDate} onClick={() => void save()}><span className="material-symbols-rounded">event_available</span>Phân ca ({selectedIds.length})</button>
        </div>
      </section>

      <section className="admin-panel schedule-board-panel">
        <PanelTitle
          eyebrow={`${activeEmployees.length} nhân sự · ${data.shiftAssignments.length} lịch trong tháng`}
          title="Lịch làm việc tuần"
          action={(
            <div className="schedule-week-actions">
              <SpreadsheetActions disabled={busy} onExport={() => { void onRun(() => exportShiftAssignmentsExcel(data, month), `Đã xuất lịch phân ca tháng ${month} ra Excel.`, { refresh: false }); }} onImport={importAssignments} />
              <button type="button" className="admin-icon-button" onClick={() => setWeek(addDays(weekStart, -7))} aria-label="Tuần trước"><span className="material-symbols-rounded">chevron_left</span></button>
              <button type="button" className="admin-secondary-button" onClick={() => setWeek(mondayOf(today))}>Tuần này</button>
              <button type="button" className="admin-icon-button" onClick={() => setWeek(addDays(weekStart, 7))} aria-label="Tuần sau"><span className="material-symbols-rounded">chevron_right</span></button>
            </div>
          )}
        />
        <div className="admin-filter-row schedule-filters">
          <SearchField value={query} onChange={setQuery} placeholder="Tên, mã, phòng ban…" />
          <AdminSelect value={center} onChange={setCenter} label="Lọc chi nhánh" options={[{ value: 'all', label: 'Mọi chi nhánh' }, ...data.locations.map((location) => ({ value: location.center_id, label: location.center_name }))]} />
          <button type="button" className="admin-text-button" onClick={() => setSelectedIds(activeEmployees.map((employee) => employee.employee_id))}>Chọn tất cả đang lọc</button>
          {selectedIds.length ? <button type="button" className="admin-text-button" onClick={() => setSelectedIds([])}>Bỏ chọn</button> : null}
        </div>

        <div className="schedule-board-scroll">
          <div className="schedule-board" role="table" aria-label="Lịch phân ca theo tuần">
            <div className="schedule-row schedule-head" role="row">
              <span>Nhân viên</span>
              {weekDays.map((day) => <span className={day === today ? 'today' : ''} key={day}>{dayFormatter.format(parseDate(day))}</span>)}
            </div>
            {activeEmployees.map((employee) => (
              <div className="schedule-row" role="row" key={employee.employee_id}>
                <label className="schedule-person">
                  <input type="checkbox" checked={selectedIds.includes(employee.employee_id)} onChange={(event) => toggleEmployee(employee.employee_id, event.target.checked)} />
                  <span><strong>{employee.name}</strong><small>{employee.employee_id} · {employee.center_id}</small></span>
                </label>
                {weekDays.map((day) => {
                  const assignment = assignments.get(`${employee.employee_id}:${day}`);
                  const shift = assignment ? shifts.get(assignment.shift_id) : undefined;
                  return (
                    <div className={`schedule-cell ${day === today ? 'today' : ''} ${assignment ? 'assigned' : ''}`} key={day}>
                      <button type="button" className="schedule-cell-button" onClick={() => {
                        setWorkDate(day);
                        if (assignment) selectAssignment(assignment);
                        else setSelectedIds([employee.employee_id]);
                      }}>
                        {shift ? <><strong>{shift.name}</strong><small>{displayTime(shift.start_time)}–{displayTime(shift.end_time)}</small></> : <span>+ Gán ca</span>}
                      </button>
                      {assignment && day >= today ? <button type="button" className="schedule-remove" onClick={() => setDeleteTarget(assignment)} aria-label={`Xóa ca của ${employee.name} ngày ${day}`}><span className="material-symbols-rounded">close</span></button> : null}
                    </div>
                  );
                })}
              </div>
            ))}
            {!activeEmployees.length ? <EmptyState icon="person_search" title="Không có nhân sự phù hợp" /> : null}
          </div>
        </div>
      </section>

      <ConfirmDialog
        isOpen={Boolean(deleteTarget)}
        title="Xóa lịch phân ca?"
        message="Timesheet chưa phát sinh sẽ trở về giờ làm theo chính sách mặc định."
        confirmLabel="Xóa lịch"
        onConfirm={() => void remove()}
        onCancel={() => setDeleteTarget(null)}
        isLoading={busy}
        type="warning"
      />
    </div>
  );
}
