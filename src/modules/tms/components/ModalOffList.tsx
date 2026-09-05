
import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import Avatar from '@/shared/components/common/Avatar';
import { triggerHaptic } from '@/core/utils/helpers';
import type { Employee, LeaveRequest } from '@/shared/types';

type LeaveWithEmployee = LeaveRequest & { emp?: Employee };
export interface LeaveGroup { id: string; title: string; items: LeaveWithEmployee[]; }
interface TypeConfig { label: string; tone: string; }

interface Props {
  leaveGroups: LeaveGroup[];
  expandedLeaveGroup: string | null;
  setExpandedLeaveGroup: React.Dispatch<React.SetStateAction<string | null>>;
  generateCalendar: () => (Date | null)[];
  getLeavesForDate: (date: Date) => LeaveRequest[];
  getTypeConfig: (type: string, isLeave: boolean) => TypeConfig;
  selectedDate: Date;
  setSelectedDate: (date: Date) => void;
}

const ModalOffList: React.FC<Props> = ({ leaveGroups, expandedLeaveGroup, setExpandedLeaveGroup, generateCalendar, getLeavesForDate, getTypeConfig, selectedDate, setSelectedDate }) => {
  return (
    <motion.div
      key="calendar"
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -20 }}
      transition={{ duration: 0.2 }}
    >
      <h3 className="app-section-title app-section-title-spaced">
        <i className="fa-solid fa-calendar-days text-xxs"></i>
        Lịch làm việc
      </h3>

      <div className="app-surface calendar-surface">
        <div className="grid grid-cols-7 mb-3">
          {["CN", "T2", "T3", "T4", "T5", "T6", "T7"].map((d, i) => (
            <div key={i} className="text-center text-xxs font-extrabold text-slate-400 dark:text-dark-text-secondary uppercase tracking-wide">{d}</div>
          ))}
        </div>

        <div className="grid grid-cols-7 gap-1">
          {generateCalendar().map((date, idx) => {
            if (!date) return <div key={idx} className="h-16 bg-slate-50/30 dark:bg-dark-bg/50 rounded-lg"></div>;

            const leaves = getLeavesForDate(date);
            const isToday = date.toDateString() === new Date().toDateString();
            const isSelected = date.toDateString() === selectedDate.toDateString();

            return (
              <button
                type="button"
                aria-pressed={isSelected}
                aria-label={`${date.getDate()}/${date.getMonth() + 1}: ${leaves.length} nhân sự nghỉ`}
                key={idx}
                onClick={() => { triggerHaptic('light'); setSelectedDate(date); }}
                className={`w-full h-16 p-1 border rounded-xl flex flex-col items-center justify-center text-center transition-all duration-200 cursor-pointer active:scale-95 ${
                  isSelected
                    ? 'border-primary bg-primary/5 dark:border-primary dark:bg-primary/10 ring-2 ring-primary/20'
                    : isToday
                      ? 'border-primary/20 bg-primary/10 dark:border-primary/30 dark:bg-primary/20'
                      : 'border-slate-50 dark:border-dark-border/50 bg-neutral-white dark:bg-dark-surface hover:border-slate-200 dark:hover:border-dark-border'
                }`}
              >
                <span className={`text-sm font-black tabular-nums  ${
                  date.getDay() === 0 && !isToday && !isSelected
                    ? 'text-secondary-red dark:text-secondary-red'
                    : (isToday || isSelected)
                      ? 'text-primary dark:text-primary'
                      : 'text-slate-900 dark:text-dark-text-primary'
                }`}>{date.getDate()}</span>
                {leaves.length > 0 && (
                  <span className="mt-1 text-xs font-extrabold text-primary dark:text-primary">
                    +{leaves.length}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* NHÂN SỰ NGHỈ SECTION */}
      <div className="mt-8 animate-slide-up">
        <h3 className="app-section-title app-section-title-spaced">
          <i className="fa-solid fa-user-clock text-xxs"></i>
          {selectedDate.toDateString() === new Date().toDateString() ? 'Nhân sự nghỉ hôm nay' : `Nhân sự nghỉ ngày ${selectedDate.getDate()}/${selectedDate.getMonth() + 1}`}
        </h3>

        {leaveGroups.length > 0 ? (
          <div className="app-list-surface divide-y divide-slate-100 dark:divide-dark-border">
            {leaveGroups.map((group) => {
              const isExpanded = expandedLeaveGroup === group.id;
              return (
                <div key={group.id} className="transition-all duration-300">
                  <button
                    type="button"
                    aria-expanded={isExpanded}
                    onClick={() => { triggerHaptic('light'); setExpandedLeaveGroup(prev => prev === group.id ? null : group.id); }}
                    className="w-full px-4 py-3 flex items-center justify-between cursor-pointer select-none group/header active:bg-slate-50 dark:active:bg-dark-border/50 transition-colors"
                  >
                    <div className="flex items-center gap-2 text-primary dark:text-primary">
                      <span className="text-xs font-black uppercase tracking-widest">{group.title}</span>
                    </div>
                    <div className="flex items-center justify-center">
                      <span className="bg-primary/10 dark:bg-primary/20 text-primary dark:text-primary px-2 py-0.5 rounded-md text-xs font-bold tabular-nums">{group.items.length}</span>
                    </div>
                  </button>

                  <AnimatePresence initial={false}>
                    {isExpanded && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.2 }}
                        className="overflow-hidden"
                      >
                        <div className="divide-y divide-slate-50 dark:divide-dark-border border-t border-slate-100 dark:border-dark-border bg-neutral-white dark:bg-dark-surface">
                          {group.items.map((item) => {
                            const config = getTypeConfig(item.type || '', true);
                            const itemName = item.name || item.emp?.name || item.employee_id;
                            return (
                              <div key={item.id} className="p-4 flex items-center gap-3.5 hover-surface">
                                <Avatar
                                  src={item.emp?.face_ref_url}
                                  name={itemName}
                                  className="w-10 h-10 rounded-xl"
                                  textSize="text-xs"
                                />
                                <div className="flex-1 min-w-0">
                                  <div className="flex justify-between items-center gap-4">
                                    <h6 className="font-black text-neutral-black dark:text-dark-text-primary text-sm leading-tight truncate">{itemName}</h6>
                                    <div className="flex gap-1">
                                      {item.emp?.department && (
                                        <span className="app-meta-chip px-2 py-0.5 rounded-md bg-primary/10 dark:bg-primary/20 text-primary dark:text-primary text-xxs font-extrabold border border-primary/20 dark:border-primary/30 uppercase tracking-wide truncate">
                                          {item.emp.department}
                                        </span>
                                      )}
                                      {item.emp?.position && (
                                        <span className="app-meta-chip px-2 py-0.5 rounded-md bg-secondary-purple/10 dark:bg-secondary-purple/20 text-secondary-purple dark:text-secondary-purple text-xxs font-extrabold border border-secondary-purple/20 dark:border-secondary-purple/30 uppercase tracking-wide truncate">
                                          {item.emp.position}
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                  <div className="flex flex-wrap gap-1 mt-1.5">
                                    <span className={`request-status status-tone-${config.tone}`}>{config.label}</span>
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              )
            })}
          </div>
        ) : (
          <div className="bg-neutral-white dark:bg-dark-surface rounded-xl border border-dashed border-slate-200 dark:border-dark-border p-8 text-center">
            <div className="w-10 h-10 bg-slate-50 dark:bg-dark-bg rounded-full flex items-center justify-center mx-auto mb-3">
              <i className="fa-solid fa-user-check text-slate-300 dark:text-dark-text-secondary"></i>
            </div>
            <p className="text-slate-400 dark:text-dark-text-secondary text-xs font-bold uppercase tracking-widest">Không có nhân sự nghỉ</p>
          </div>
        )}
      </div>
    </motion.div>
  );
};

export default ModalOffList;
