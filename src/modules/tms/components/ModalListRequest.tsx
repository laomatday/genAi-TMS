
import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { Employee, Explanation, LeaveRequest } from '@/shared/types';
import Avatar from '@/shared/components/common/Avatar';
import { formatDateString, triggerHaptic } from '@/core/utils/helpers';

export type ApprovalItem = ((LeaveRequest & { itemType: 'leave' }) | (Explanation & { itemType: 'explanation' })) & { emp?: Employee };
export interface ApprovalGroup { id: string; title: string; items: ApprovalItem[]; }
export interface ApprovalTypeConfig { label: string; icon: string; tone: string; }

interface Props {
  expandedApprovalGroup: string | null;
  setExpandedApprovalGroup: React.Dispatch<React.SetStateAction<string | null>>;
  totalPending: number;
  approvalGroups: ApprovalGroup[];
  renderDateRange: (from: string, to: string) => string;
  getTypeConfig: (type: string, isLeave: boolean) => ApprovalTypeConfig;
  onOpenDetail: (item: ApprovalItem) => void;
}

const ModalListRequest: React.FC<Props> = ({
  expandedApprovalGroup,
  setExpandedApprovalGroup,
  totalPending,
  approvalGroups,
  renderDateRange,
  getTypeConfig,
  onOpenDetail,
}) => {
  return (
    <motion.div
      key="approvals"
      initial={{ opacity: 0, x: -20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 20 }}
      transition={{ duration: 0.2 }}
      className="ui-stack"
    >
      <div className="ui-label-row">
        <span className="ui-label">Hàng đợi phê duyệt</span>
        <span className={`ui-pill ${totalPending > 0 ? 'ui-pill-danger' : 'ui-pill-success'}`}>
          <span className="ui-pill-dot" aria-hidden="true" />
          {totalPending > 0 ? `${totalPending} chờ duyệt` : 'Đã xử lý hết'}
        </span>
      </div>

      {totalPending === 0 ? (
        <div className="ui-empty">
          <span className="material-symbols-rounded" aria-hidden="true">task_alt</span>
          <span className="ui-empty-title">Không còn đề xuất nào</span>
          <span className="ui-empty-text">Đơn nghỉ phép và giải trình của nhân sự bạn quản lý sẽ xuất hiện tại đây.</span>
        </div>
      ) : (
        <div className="ui-stack">
          {approvalGroups.map((group) => {
            const isExpanded = expandedApprovalGroup === group.id;
            return (
              <section key={group.id} className="ui-card ui-card-flush">
                <button
                  type="button"
                  aria-expanded={isExpanded}
                  onClick={() => { triggerHaptic('light'); setExpandedApprovalGroup(prev => prev === group.id ? null : group.id); }}
                  className="ui-card-head"
                >
                  <span className="ui-tile ui-tile-soft ui-tone-primary" aria-hidden="true">
                    <span className="material-symbols-rounded">{group.id === 'direct' ? 'groups' : 'apartment'}</span>
                  </span>
                  <span className="ui-card-head-text">
                    <span className="ui-card-head-title">{group.title}</span>
                    <span className="ui-card-head-sub">{group.items.length} đề xuất đang chờ</span>
                  </span>
                  <span className="ui-pill ui-pill-muted">{group.items.length}</span>
                  <span className={`material-symbols-rounded ui-card-head-chevron ${isExpanded ? 'ui-card-head-chevron-open' : ''}`.trim()} aria-hidden="true">expand_more</span>
                </button>

                <AnimatePresence initial={false}>
                  {isExpanded && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.2 }}
                      className="overflow-hidden ui-card-section"
                    >
                      {group.items.map((item) => {
                        const isLeave = item.itemType === 'leave';
                        const config = getTypeConfig(item.itemType === 'leave' ? item.type : '', isLeave);
                        const dateInfo = item.itemType === 'leave'
                          ? renderDateRange(item.from_date, item.to_date)
                          : formatDateString(item.date.split('T')[0]);
                        const itemName = item.name || item.emp?.name || item.employee_id;
                        return (
                          <article key={item.id} className="approval-item">
                            <button type="button" className="approval-open" onClick={() => onOpenDetail(item)}>
                              <span className="approval-head">
                                <span className="approval-figure">
                                  <Avatar
                                    src={item.emp?.face_ref_url || item.emp?.avatar_url}
                                    name={itemName}
                                    className="w-10 h-10 rounded-xl"
                                    textSize="text-xs"
                                  />
                                  <span className={`approval-badge ui-tone-${config.tone}`} aria-hidden="true">
                                    <span className="material-symbols-rounded">{config.icon}</span>
                                  </span>
                                </span>

                                <span className="approval-title">
                                  <span className="approval-name">{itemName}</span>
                                  <span className="approval-meta">
                                    <span className={`ui-pill ui-pill-${config.tone === 'muted' ? 'muted' : config.tone}`}>{config.label}</span>
                                    <span className="approval-date">{dateInfo}</span>
                                  </span>
                                  <span className="approval-meta">
                                    {item.emp?.department ? <span className="ui-pill ui-pill-muted">{item.emp.department}</span> : null}
                                    {item.emp?.position ? <span className="ui-pill ui-pill-muted">{item.emp.position}</span> : null}
                                  </span>
                                </span>
                              </span>

                              <span className="request-card-reason request-card-reason-clamped">
                                <strong>Lý do:</strong> {item.reason}
                              </span>

                              <span className="approval-open-cta">
                                Xem chi tiết
                                <span className="material-symbols-rounded" aria-hidden="true">arrow_forward</span>
                              </span>
                            </button>
                          </article>
                        );
                      })}
                    </motion.div>
                  )}
                </AnimatePresence>
              </section>
            );
          })}
        </div>
      )}
    </motion.div>
  );
};

export default ModalListRequest;
