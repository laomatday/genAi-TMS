import React, { useState, useMemo, useEffect } from 'react';
import type { DashboardData, Employee, Explanation, LeaveRequest } from '@/shared/types';
import { deleteRequest, deleteExplanation } from '@/modules/tms/services/employee';
import { useToast } from '@/shared/contexts/useToast';
import ConfirmDialog from '@/shared/components/modals/ConfirmDialog';
import { formatDateString, triggerHaptic } from '@/core/utils/helpers';
import PullToRefresh from '@/shared/components/layout/PullToRefresh';
import { motion, AnimatePresence } from 'framer-motion';
import type { RegisterSwipeHandler } from '@/modules/tms/components/BottomNav';

interface Props {
    data: DashboardData | null;
    user: Employee;
    onRefresh: () => Promise<void>;
    registerSwipeHandler?: RegisterSwipeHandler;
}

type RequestListItem = (LeaveRequest & { itemType: 'leave' }) | (Explanation & { itemType: 'explanation' });

const TabRequests: React.FC<Props> = ({ data, onRefresh, user, registerSwipeHandler }) => {
    const [viewMode, setViewMode] = useState<'leaves' | 'explanations'>('leaves');
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const [deleteConfirm, setDeleteConfirm] = useState<{ id: string, type: 'leave' | 'explanation' } | null>(null);
    const { showToast } = useToast();

    useEffect(() => {
        if (registerSwipeHandler) {
            return registerSwipeHandler((direction) => {
                if (direction === 'left' && viewMode === 'leaves') { triggerHaptic('light'); setViewMode('explanations'); setExpandedId(null); return true; }
                if (direction === 'right' && viewMode === 'explanations') { triggerHaptic('light'); setViewMode('leaves'); setExpandedId(null); return true; }
                return false;
            });
        }
        return undefined;
    }, [registerSwipeHandler, viewMode]);

    const requests = useMemo(() => [...(data?.myRequests || [])].sort((a,b)=>new Date(b.created_at).getTime()-new Date(a.created_at).getTime()), [data?.myRequests]);
    const explanations = useMemo(() => [...(data?.myExplanations || [])].sort((a,b)=>new Date(b.created_at).getTime()-new Date(a.created_at).getTime()), [data?.myExplanations]);

    const getStatusConfig = (status: string) => {
        switch (status) {
            case 'Approved': return { label:'Đã duyệt', tone:'success', icon:'check_circle' };
            case 'Rejected': return { label:'Từ chối', tone:'danger', icon:'cancel' };
            default: return { label:'Chờ duyệt', tone:'warning', icon:'pause_circle' };
        }
    };
    const getTypeConfig = (type: string) => {
        if(type.includes('Nghỉ phép')) return {icon:'beach_access',tone:'primary'};
        if(type.includes('Nghỉ ốm')) return {icon:'medical_services',tone:'danger'};
        if(type.includes('Nghỉ không lương')) return {icon:'event_busy',tone:'warning'};
        if(type.includes('Làm việc tại nhà')) return {icon:'home_work',tone:'success'};
        if(type.includes('Công tác')) return {icon:'flight_takeoff',tone:'info'};
        if(type.includes('Giải trình')) return {icon:'assignment_turned_in',tone:'info'};
        return {icon:'description',tone:'muted'};
    };

    const stats = useMemo(() => viewMode === 'leaves' ? {
        col1:{label:'Chờ duyệt',value:requests.filter(r=>r.status==='Pending').length,tone:'warning'},
        col2:{label:'Đã duyệt',value:requests.filter(r=>r.status==='Approved').length,tone:'primary'},
        col3:{label:'Quỹ phép',value:user.annual_leave_balance||0,tone:'success'}
    } : {
        col1:{label:'Chờ duyệt',value:explanations.filter(e=>e.status==='Pending').length,tone:'warning'},
        col2:{label:'Đã duyệt',value:explanations.filter(e=>e.status==='Approved').length,tone:'primary'},
        col3:{label:'Từ chối',value:explanations.filter(e=>e.status==='Rejected').length,tone:'danger'}
    }, [viewMode,requests,explanations,user]);

    const switchViewMode=(mode:'leaves'|'explanations')=>{triggerHaptic('light');setViewMode(mode);setExpandedId(null);};
    const toggleExpand=(id:string)=>{triggerHaptic('light');setExpandedId(prev=>prev===id?null:id);};
    const handleDelete=async()=>{
        if(!deleteConfirm)return; triggerHaptic('medium');
        const res=deleteConfirm.type==='leave'?await deleteRequest(deleteConfirm.id):await deleteExplanation(deleteConfirm.id);
        if(res.success){showToast({title:'Thành công',body:res.message,type:'success'});onRefresh();}else showToast({title:'Lỗi',body:res.message,type:'error'});
        setDeleteConfirm(null);
    };
    const containerVariants={hidden:{opacity:0},show:{opacity:1,transition:{staggerChildren:.1}}};
    const itemVariants={hidden:{opacity:0,y:20},show:{opacity:1,y:0,transition:{type:'spring' as const,stiffness:300,damping:24}} as const,exit:{opacity:0,scale:.9,transition:{duration:.2}}};

    const renderList = (mode:'leaves'|'explanations') => {
        const isLeave=mode==='leaves';
        const source: RequestListItem[] = isLeave
            ? requests.map((request) => ({ ...request, itemType: 'leave' }))
            : explanations.map((explanation) => ({ ...explanation, itemType: 'explanation' }));
        return <div>
            <h3 className="app-section-title requests-list-title"><span className="material-symbols-rounded" aria-hidden="true">{isLeave?'beach_access':'history_edu'}</span>{isLeave?'Danh sách đơn nghỉ phép':'Danh sách giải trình'}</h3>
            {source.length===0 ? <motion.div initial={{opacity:0,scale:.9}} animate={{opacity:1,scale:1}} className="flex flex-col items-center justify-center py-12 text-slate-400 dark:text-dark-text-secondary opacity-60 bg-white dark:bg-dark-surface rounded-xl border border-dashed border-slate-200 dark:border-dark-border"><div className="w-16 h-16 bg-slate-50 dark:bg-dark-border/50 rounded-full flex items-center justify-center mb-3"><span className="material-symbols-rounded text-3xl text-slate-300 dark:text-dark-text-secondary">{isLeave?'folder_open':'history_edu'}</span></div><p className="text-sm font-bold text-slate-500 dark:text-dark-text-primary">{isLeave?'Chưa có đề xuất nào':'Chưa có giải trình nào'}</p></motion.div> :
            <motion.div variants={containerVariants} initial="hidden" animate="show" className="app-list-surface divide-y divide-slate-100 dark:divide-dark-border"><AnimatePresence>{source.map((raw)=>{
                const id=raw.id; const statusInfo=getStatusConfig(raw.status); const typeInfo=raw.itemType==='leave'?getTypeConfig(raw.type):{icon:'history_edu',tone:'info'}; const isExpanded=expandedId===id;
                return <motion.div variants={itemVariants} key={id} role="button" tabIndex={0} aria-expanded={isExpanded} className="w-full relative hover-surface group cursor-pointer" onClick={()=>toggleExpand(id)} onKeyDown={(event)=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();toggleExpand(id);}}}>
                    <div className="p-4 flex gap-3.5 relative"><div className={`app-item-icon app-icon-tone-${typeInfo.tone}`}><span className="material-symbols-rounded">{typeInfo.icon}</span></div>
                    <div className="flex-1 min-w-0 pt-0.5 relative"><div className="flex justify-between items-start mb-1"><h4 className="font-bold text-slate-800 dark:text-dark-text-primary text-sm leading-tight truncate pr-2">{raw.itemType==='leave'?raw.type:'Giải trình công'}</h4><span className={`request-status status-tone-${statusInfo.tone}`}><span className="material-symbols-rounded">{statusInfo.icon}</span>{statusInfo.label}</span></div>
                    <div className="pr-8"><div className="flex items-center gap-2 text-xxs font-bold text-slate-500 dark:text-dark-text-secondary font-sans mb-0.5">{raw.itemType==='leave'?(raw.from_date===raw.to_date?formatDateString(raw.from_date):`${formatDateString(raw.from_date)} - ${formatDateString(raw.to_date)}`):formatDateString(raw.date)}</div><p className={`text-xxs text-slate-500 dark:text-dark-text-secondary italic ${isExpanded?'':'line-clamp-1'}`}><span className="font-bold not-italic">Lý do:</span> {raw.reason}</p></div>
                    {raw.status==='Pending'&&<button type="button" aria-label="Xóa yêu cầu" onClick={(e)=>{e.stopPropagation();setDeleteConfirm({id,type:raw.itemType});}} className="absolute bottom-0 right-0 w-7 h-7 rounded-full bg-slate-50 dark:bg-dark-border flex items-center justify-center text-slate-400 hover:text-secondary-red hover:bg-secondary-red/10 transition-colors"><span className="material-symbols-rounded text-sm">delete</span></button>}</div></div>
                    <div className={`overflow-hidden transition-all duration-300 ease-in-out ${isExpanded?'max-h-40 opacity-100':'max-h-0 opacity-0'}`}>{raw.manager_note&&<div className="mx-4 mb-4 mt-1 pl-3 py-1 border-l-2 border-slate-200 dark:border-dark-border"><p className="text-xxs font-bold text-slate-400 dark:text-dark-text-secondary uppercase tracking-widest mb-0.5">Quản lý phản hồi:</p><p className="text-xs font-medium text-slate-700 dark:text-dark-text-primary leading-relaxed">{raw.manager_note}</p></div>}</div>
                </motion.div>;
            })}</AnimatePresence></motion.div>}
        </div>;
    };

    return <><PullToRefresh onRefresh={onRefresh} className="page-bg font-sans"><div className="employee-page employee-page-standard requests-page animate-fade-in space-y-8">
        <div className="app-segmented"><button type="button" onClick={()=>switchViewMode('leaves')} className={`app-segmented-option ${viewMode==='leaves'?'app-segmented-option-active':''}`}>Nghỉ phép</button><button type="button" onClick={()=>switchViewMode('explanations')} className={`app-segmented-option ${viewMode==='explanations'?'app-segmented-option-active':''}`}>Giải trình</button></div>
        <div className="app-kpi-grid requests-kpi-grid">{[stats.col1,stats.col2,stats.col3].map((s)=><div key={s.label} className="app-kpi-card"><strong className={`status-tone-${s.tone} tabular-nums`}>{s.value}</strong><span>{s.label}</span></div>)}</div>
        {renderList(viewMode)}
    </div></PullToRefresh><ConfirmDialog isOpen={!!deleteConfirm} title="Xác nhận xoá" message="Bạn có chắc chắn muốn xoá đơn này không? Hành động này không thể hoàn tác." confirmLabel="Xoá đơn" onConfirm={handleDelete} onCancel={()=>setDeleteConfirm(null)} type="danger" /></>;
};
export default TabRequests;
