import { isSupabaseConfigured, supabase } from '@/core/supabase';

export interface WorkforceScheduleItem {
  id: string;
  workDate: string;
  shiftName: string;
  startTime: string;
  endTime: string;
  locationId: string | null;
  locationName: string | null;
  note: string;
}

export interface WorkforceSchedule {
  items: WorkforceScheduleItem[];
  total: number;
}

type DataRow = Record<string, unknown>;

function asRow(value: unknown): DataRow {
  return value && typeof value === 'object' ? value as DataRow : {};
}

function asText(value: unknown) {
  return typeof value === 'string' ? value : '';
}

function asNullableText(value: unknown) {
  const text = asText(value);
  return text || null;
}

function mapScheduleItem(value: unknown): WorkforceScheduleItem | null {
  const row = asRow(value);
  const id = asText(row.id);
  const workDate = asText(row.work_date);
  const startTime = asText(row.start_time);
  const endTime = asText(row.end_time);
  if (!id || !/^\d{4}-\d{2}-\d{2}$/.test(workDate) || !startTime || !endTime) return null;
  return {
    id,
    workDate,
    shiftName: asText(row.shift_name) || 'Ca làm việc',
    startTime,
    endTime,
    locationId: asNullableText(row.location_id),
    locationName: asNullableText(row.location_name),
    note: asText(row.note),
  };
}

export function normalizeWorkforceSchedule(payload: unknown): WorkforceSchedule {
  const result = asRow(payload);
  const rows = Array.isArray(result.rows) ? result.rows : [];
  const total = Number(result.total);
  return {
    items: rows.map(mapScheduleItem).filter((item): item is WorkforceScheduleItem => item !== null),
    total: Number.isFinite(total) ? Math.max(0, total) : 0,
  };
}

export async function getMySchedule(from: string, to: string): Promise<WorkforceSchedule> {
  if (!isSupabaseConfigured) throw new Error('Chưa cấu hình Supabase.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) {
    throw new Error('Khoảng ngày lịch làm việc không hợp lệ.');
  }
  const { data, error } = await supabase.rpc('workforce_query', {
    p_resource: 'schedule',
    p_args: { scope: 'me', from, to, page: 1, size: 63 },
  });
  if (error) throw new Error(error.message || 'Không tải được ca làm việc.');
  return normalizeWorkforceSchedule(data);
}
