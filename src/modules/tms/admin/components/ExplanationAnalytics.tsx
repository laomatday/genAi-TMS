import { useMemo, useState } from 'react';
import {
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Tooltip as RechartsTooltip,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Legend,
} from 'recharts';
import type { AttendanceRequest } from '../types';
import type { AdminSection } from '../constants';
import { PanelTitle } from './AdminCommon';

interface ExplanationAnalyticsProps {
  requests: AttendanceRequest[];
  monthlyRequests?: AttendanceRequest[];
  onNavigate: (section: AdminSection) => void;
}

const COLORS = {
  PENDING: '#f59e0b', // Amber-500
  APPROVED: '#10b981', // Emerald-500
  REJECTED: '#ef4444', // Rose-500
  MUTED: '#94a3b8',
};

interface TooltipPayloadItem {
  name?: string;
  value?: number;
  color?: string;
  dataKey?: string;
  payload?: {
    date?: string;
    displayDate?: string;
    pending?: number;
    approved?: number;
    rejected?: number;
    total?: number;
    name?: string;
    value?: number;
    percentage?: number;
    statusKey?: string;
  };
}

interface CustomTooltipProps {
  active?: boolean;
  payload?: TooltipPayloadItem[];
}

function CustomPieTooltip({ active, payload }: CustomTooltipProps) {
  if (!active || !payload || !payload.length) return null;
  const item = payload[0];
  if (!item) return null;
  const data = item.payload;

  return (
    <div className="admin-custom-tooltip">
      <div className="flex items-center gap-2 font-bold text-sm text-slate-800 dark:text-slate-100">
        <span
          className="w-3 h-3 rounded-full"
          style={{ backgroundColor: item.color || COLORS.MUTED }}
        />
        <span>{item.name}</span>
      </div>
      <div className="mt-1 text-xs text-slate-600 dark:text-slate-300 flex justify-between gap-4">
        <span>Số lượng đơn:</span>
        <strong className="text-slate-900 dark:text-white">{item.value} đơn</strong>
      </div>
      {data?.percentage !== undefined && (
        <div className="text-xs text-slate-500 dark:text-slate-400 flex justify-between gap-4">
          <span>Tỷ trọng:</span>
          <strong>{data.percentage}%</strong>
        </div>
      )}
    </div>
  );
}

function CustomBarTooltip({ active, payload }: CustomTooltipProps) {
  if (!active || !payload || !payload.length) return null;
  const first = payload[0];
  if (!first || !first.payload) return null;
  const data = first.payload;

  return (
    <div className="admin-custom-tooltip min-w-[160px]">
      <div className="font-bold text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 pb-1 mb-1 border-b border-slate-200 dark:border-slate-700">
        Ngày {data.displayDate || data.date}
      </div>
      <div className="space-y-1 text-xs">
        <div className="flex items-center justify-between gap-3 text-amber-600 dark:text-amber-400 font-medium">
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-amber-500" />
            Chờ duyệt (Pending):
          </span>
          <strong>{data.pending || 0}</strong>
        </div>
        <div className="flex items-center justify-between gap-3 text-emerald-600 dark:text-emerald-400 font-medium">
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-emerald-500" />
            Đã duyệt (Approved):
          </span>
          <strong>{data.approved || 0}</strong>
        </div>
        <div className="flex items-center justify-between gap-3 text-rose-600 dark:text-rose-400 font-medium">
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-rose-500" />
            Từ chối (Rejected):
          </span>
          <strong>{data.rejected || 0}</strong>
        </div>
        <div className="pt-1 mt-1 border-t border-slate-200 dark:border-slate-700 flex justify-between text-slate-700 dark:text-slate-200 font-bold">
          <span>Tổng cộng:</span>
          <span>{data.total || 0} đơn</span>
        </div>
      </div>
    </div>
  );
}

export default function ExplanationAnalytics({
  requests,
  monthlyRequests,
  onNavigate,
}: ExplanationAnalyticsProps) {
  const [viewType, setViewType] = useState<'donut' | 'bar'>('donut');

  // Use monthly requests if available, fallback to active requests
  const sourceRequests = useMemo(() => {
    const all = monthlyRequests && monthlyRequests.length > 0 ? monthlyRequests : requests;
    // Filter explanation requests (or all requests if not specifically typed)
    return all.filter((r) => r.request_type === 'EXPLANATION' || !r.request_type);
  }, [monthlyRequests, requests]);

  // Aggregate counts
  const stats = useMemo(() => {
    let pending = 0;
    let approved = 0;
    let rejected = 0;

    for (const r of sourceRequests) {
      if (r.status === 'PENDING') pending += 1;
      else if (r.status === 'APPROVED') approved += 1;
      else if (r.status === 'REJECTED') rejected += 1;
      else pending += 1; // Default
    }

    const total = pending + approved + rejected;
    const resolved = approved + rejected;
    const resolutionRate = total > 0 ? Math.round((resolved / total) * 100) : 100;
    const approvalRate = resolved > 0 ? Math.round((approved / resolved) * 100) : 0;

    return {
      pending,
      approved,
      rejected,
      total,
      resolved,
      resolutionRate,
      approvalRate,
    };
  }, [sourceRequests]);

  // Pie chart data
  const pieData = useMemo(() => {
    if (stats.total === 0) return [];
    return [
      {
        name: 'Chờ duyệt (Pending)',
        value: stats.pending,
        color: COLORS.PENDING,
        statusKey: 'PENDING',
        percentage: stats.total ? Math.round((stats.pending / stats.total) * 100) : 0,
      },
      {
        name: 'Đã duyệt (Approved)',
        value: stats.approved,
        color: COLORS.APPROVED,
        statusKey: 'APPROVED',
        percentage: stats.total ? Math.round((stats.approved / stats.total) * 100) : 0,
      },
      {
        name: 'Từ chối (Rejected)',
        value: stats.rejected,
        color: COLORS.REJECTED,
        statusKey: 'REJECTED',
        percentage: stats.total ? Math.round((stats.rejected / stats.total) * 100) : 0,
      },
    ].filter((item) => item.value > 0);
  }, [stats]);

  // Timeline bar chart data (Grouped by date)
  const barData = useMemo(() => {
    const map = new Map<
      string,
      { date: string; displayDate: string; pending: number; approved: number; rejected: number; total: number }
    >();

    for (const r of sourceRequests) {
      const rawDate = r.work_date || (r.created_at ? r.created_at.slice(0, 10) : 'N/A');
      let displayDate = rawDate;
      if (rawDate.includes('-')) {
        const parts = rawDate.split('-');
        if (parts.length === 3) displayDate = `${parts[2]}/${parts[1]}`;
      }

      const current = map.get(rawDate) || {
        date: rawDate,
        displayDate,
        pending: 0,
        approved: 0,
        rejected: 0,
        total: 0,
      };

      if (r.status === 'PENDING') current.pending += 1;
      else if (r.status === 'APPROVED') current.approved += 1;
      else if (r.status === 'REJECTED') current.rejected += 1;
      else current.pending += 1;

      current.total += 1;
      map.set(rawDate, current);
    }

    return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
  }, [sourceRequests]);

  return (
    <section className="admin-panel admin-explanation-analytics-card">
      <PanelTitle
        eyebrow="Khối lượng công việc tháng"
        title="Thống kê đơn giải trình (Pending vs Approved/Rejected)"
        action={
          <div className="flex items-center gap-2">
            <div className="admin-chart-toggle-group">
              <button
                type="button"
                className={`admin-chart-toggle-btn ${viewType === 'donut' ? 'active' : ''}`}
                onClick={() => setViewType('donut')}
                title="Biểu đồ cơ cấu tròn"
              >
                <span className="material-symbols-rounded text-sm" aria-hidden="true">
                  donut_small
                </span>
                <span>Cơ cấu</span>
              </button>
              <button
                type="button"
                className={`admin-chart-toggle-btn ${viewType === 'bar' ? 'active' : ''}`}
                onClick={() => setViewType('bar')}
                title="Biểu đồ cột theo ngày"
              >
                <span className="material-symbols-rounded text-sm" aria-hidden="true">
                  bar_chart
                </span>
                <span>Theo ngày</span>
              </button>
            </div>
            <button
              type="button"
              className="admin-text-button flex items-center gap-1 font-semibold text-sm"
              onClick={() => onNavigate('attendance')}
            >
              <span>Xử lý đơn</span>
              <span className="material-symbols-rounded text-base" aria-hidden="true">
                arrow_forward
              </span>
            </button>
          </div>
        }
      />

      {/* Mini KPI Strip */}
      <div className="admin-explanation-kpi-grid">
        <div className="admin-explanation-kpi-card kpi-total">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              Tổng đơn tháng
            </span>
            <span className="material-symbols-rounded text-slate-400 text-lg">edit_note</span>
          </div>
          <div className="flex items-baseline gap-2">
            <strong className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
              {stats.total}
            </strong>
            <small className="text-xs text-slate-500 font-medium">giải trình</small>
          </div>
          <div className="mt-2 text-xs text-slate-500 flex items-center gap-1">
            <span>Tiến độ xử lý:</span>
            <strong className={stats.resolutionRate === 100 ? 'text-emerald-600' : 'text-amber-600'}>
              {stats.resolutionRate}%
            </strong>
          </div>
        </div>

        <div className={`admin-explanation-kpi-card kpi-pending ${stats.pending > 0 ? 'highlight' : ''}`}>
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-400">
              Chờ duyệt (Pending)
            </span>
            <span className="material-symbols-rounded text-amber-500 text-lg">pending</span>
          </div>
          <div className="flex items-baseline gap-2">
            <strong className="text-2xl font-bold tracking-tight text-amber-600 dark:text-amber-400">
              {stats.pending}
            </strong>
            <small className="text-xs text-amber-700/80 font-medium">
              {stats.total > 0 ? `${Math.round((stats.pending / stats.total) * 100)}%` : '0%'}
            </small>
          </div>
          <div className="mt-2 text-xs text-amber-700 dark:text-amber-300 flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-500 inline-block animate-pulse" />
            <span>{stats.pending > 0 ? 'Cần Admin phê duyệt' : 'Hàng chờ sạch'}</span>
          </div>
        </div>

        <div className="admin-explanation-kpi-card kpi-approved">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
              Đã duyệt (Approved)
            </span>
            <span className="material-symbols-rounded text-emerald-500 text-lg">check_circle</span>
          </div>
          <div className="flex items-baseline gap-2">
            <strong className="text-2xl font-bold tracking-tight text-emerald-600 dark:text-emerald-400">
              {stats.approved}
            </strong>
            <small className="text-xs text-emerald-700/80 font-medium">
              {stats.total > 0 ? `${Math.round((stats.approved / stats.total) * 100)}%` : '0%'}
            </small>
          </div>
          <div className="mt-2 text-xs text-emerald-700 dark:text-emerald-300 flex items-center gap-1">
            <span>Tỷ lệ chấp thuận:</span>
            <strong>{stats.approvalRate}%</strong>
          </div>
        </div>

        <div className="admin-explanation-kpi-card kpi-rejected">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs font-semibold uppercase tracking-wider text-rose-700 dark:text-rose-400">
              Từ chối (Rejected)
            </span>
            <span className="material-symbols-rounded text-rose-500 text-lg">cancel</span>
          </div>
          <div className="flex items-baseline gap-2">
            <strong className="text-2xl font-bold tracking-tight text-rose-600 dark:text-rose-400">
              {stats.rejected}
            </strong>
            <small className="text-xs text-rose-700/80 font-medium">
              {stats.total > 0 ? `${Math.round((stats.rejected / stats.total) * 100)}%` : '0%'}
            </small>
          </div>
          <div className="mt-2 text-xs text-rose-700 dark:text-rose-300 flex items-center gap-1">
            <span>Không đủ căn cứ hợp lệ</span>
          </div>
        </div>
      </div>

      {/* Main Chart Area */}
      <div className="admin-explanation-chart-layout">
        <div className="admin-chart-stage-container">
          {stats.total === 0 ? (
            <div className="h-[240px] flex flex-col items-center justify-center text-slate-400">
              <span className="material-symbols-rounded text-4xl mb-2 text-slate-300">
                pie_chart
              </span>
              <p className="text-sm font-medium">Chưa có dữ liệu giải trình trong tháng này</p>
              <small className="text-xs text-slate-400">
                Các đơn giải trình mới từ nhân viên sẽ xuất hiện tự động tại đây
              </small>
            </div>
          ) : viewType === 'donut' ? (
            <div className="relative w-full h-[240px]">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={pieData}
                    cx="50%"
                    cy="50%"
                    innerRadius={65}
                    outerRadius={95}
                    paddingAngle={3}
                    dataKey="value"
                    animationDuration={600}
                  >
                    {pieData.map((entry) => (
                      <Cell key={entry.name} fill={entry.color} stroke="none" />
                    ))}
                  </Pie>
                  <RechartsTooltip content={<CustomPieTooltip />} />
                </PieChart>
              </ResponsiveContainer>
              <div className="admin-donut-center-badge">
                <span className="text-2xl font-bold text-slate-800 dark:text-white">
                  {stats.total}
                </span>
                <span className="text-[11px] font-semibold tracking-wider uppercase text-slate-400">
                  Tổng đơn
                </span>
              </div>
            </div>
          ) : (
            <div className="w-full h-[240px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={barData}
                  margin={{ top: 10, right: 10, left: -18, bottom: 0 }}
                  barSize={18}
                >
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" opacity={0.6} />
                  <XAxis
                    dataKey="displayDate"
                    tick={{ fontSize: 11, fill: '#64748b' }}
                    axisLine={{ stroke: '#cbd5e1' }}
                    tickLine={false}
                  />
                  <YAxis
                    allowDecimals={false}
                    tick={{ fontSize: 11, fill: '#64748b' }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <RechartsTooltip content={<CustomBarTooltip />} />
                  <Legend
                    verticalAlign="top"
                    align="right"
                    iconType="circle"
                    iconSize={8}
                    wrapperStyle={{ fontSize: '11px', paddingBottom: '6px' }}
                  />
                  <Bar
                    dataKey="approved"
                    name="Đã duyệt (Approved)"
                    stackId="a"
                    fill={COLORS.APPROVED}
                    radius={[0, 0, 0, 0]}
                  />
                  <Bar
                    dataKey="rejected"
                    name="Từ chối (Rejected)"
                    stackId="a"
                    fill={COLORS.REJECTED}
                    radius={[0, 0, 0, 0]}
                  />
                  <Bar
                    dataKey="pending"
                    name="Chờ duyệt (Pending)"
                    stackId="a"
                    fill={COLORS.PENDING}
                    radius={[3, 3, 0, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        {/* Legend / Context Breakdown */}
        <div className="admin-explanation-breakdown">
          <div className="admin-breakdown-header">
            <span className="text-xs font-bold uppercase tracking-wider text-slate-500">
              Chi tiết phân bổ
            </span>
            <span className="text-xs text-slate-400 font-medium">Tỷ trọng</span>
          </div>

          <div className="space-y-2.5">
            <div className="admin-breakdown-row">
              <div className="flex items-center gap-2.5">
                <span className="w-3 h-3 rounded-full bg-amber-500 flex-shrink-0" />
                <div>
                  <div className="text-xs font-bold text-slate-800 dark:text-slate-100">
                    Chờ duyệt (Pending)
                  </div>
                  <div className="text-[11px] text-slate-500">Khối lượng đang tồn đọng</div>
                </div>
              </div>
              <div className="text-right">
                <div className="text-xs font-bold text-amber-600 dark:text-amber-400">
                  {stats.pending} đơn
                </div>
                <div className="text-[11px] text-slate-400 font-medium">
                  {stats.total > 0 ? `${Math.round((stats.pending / stats.total) * 100)}%` : '0%'}
                </div>
              </div>
            </div>

            <div className="admin-breakdown-row">
              <div className="flex items-center gap-2.5">
                <span className="w-3 h-3 rounded-full bg-emerald-500 flex-shrink-0" />
                <div>
                  <div className="text-xs font-bold text-slate-800 dark:text-slate-100">
                    Đã duyệt (Approved)
                  </div>
                  <div className="text-[11px] text-slate-500">Đã chốt bổ sung công hợp lệ</div>
                </div>
              </div>
              <div className="text-right">
                <div className="text-xs font-bold text-emerald-600 dark:text-emerald-400">
                  {stats.approved} đơn
                </div>
                <div className="text-[11px] text-slate-400 font-medium">
                  {stats.total > 0 ? `${Math.round((stats.approved / stats.total) * 100)}%` : '0%'}
                </div>
              </div>
            </div>

            <div className="admin-breakdown-row">
              <div className="flex items-center gap-2.5">
                <span className="w-3 h-3 rounded-full bg-rose-500 flex-shrink-0" />
                <div>
                  <div className="text-xs font-bold text-slate-800 dark:text-slate-100">
                    Từ chối (Rejected)
                  </div>
                  <div className="text-[11px] text-slate-500">Không chấp thuận lý do</div>
                </div>
              </div>
              <div className="text-right">
                <div className="text-xs font-bold text-rose-600 dark:text-rose-400">
                  {stats.rejected} đơn
                </div>
                <div className="text-[11px] text-slate-400 font-medium">
                  {stats.total > 0 ? `${Math.round((stats.rejected / stats.total) * 100)}%` : '0%'}
                </div>
              </div>
            </div>
          </div>

          {/* Operational Guidance Card */}
          <div className="admin-workload-guidance">
            <div className="flex items-center gap-2 text-xs font-semibold text-slate-800 dark:text-slate-200">
              <span className={`material-symbols-rounded text-sm ${stats.pending > 0 ? 'text-amber-500' : 'text-emerald-500'}`}>
                {stats.pending > 0 ? 'warning' : 'task_alt'}
              </span>
              <span>Đánh giá khối lượng công việc</span>
            </div>
            <p className="mt-1 text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
              {stats.pending > 0
                ? `Còn ${stats.pending} đơn giải trình đang chờ Admin duyệt trước chu kỳ chốt lương cuối tháng.`
                : 'Toàn bộ đơn giải trình trong tháng đã được xử lý xong. Dữ liệu sẵn sàng đối soát công.'}
            </p>
            {stats.pending > 0 && (
              <button
                type="button"
                className="mt-2 w-full py-1.5 px-3 rounded-lg text-xs font-semibold bg-amber-500/15 hover:bg-amber-500/25 text-amber-800 dark:text-amber-200 border border-amber-500/30 flex items-center justify-center gap-1.5 transition-colors"
                onClick={() => onNavigate('attendance')}
              >
                <span className="material-symbols-rounded text-sm">assignment_turned_in</span>
                <span>Mở danh sách duyệt ngay ({stats.pending})</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
