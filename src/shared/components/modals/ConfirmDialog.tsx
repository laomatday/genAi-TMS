import { useId, type ReactNode } from 'react';
import { useModalAccessibility } from './useModalAccessibility';

interface Props { isOpen:boolean; title:string; message:ReactNode; confirmLabel?:string; cancelLabel?:string; onConfirm:()=>void; onCancel:()=>void; type?:'danger'|'success'|'info'|'warning'|'error'; isLoading?:boolean; }

const ICONS = { danger:'warning', error:'cancel', success:'check_circle', info:'info', warning:'priority_high' } as const;

const ConfirmDialog = ({isOpen,title,message,confirmLabel='Xác nhận',cancelLabel='Hủy bỏ',onConfirm,onCancel,type='info',isLoading=false}:Props) => {
  const titleId = useId();
  const messageId = useId();
  const dialogRef = useModalAccessibility<HTMLElement>(isOpen, onCancel, { closeOnEscape: !isLoading });
  if(!isOpen) return null;
  const single = !cancelLabel;

  return <div className="confirm-backdrop animate-fade-in">
    <section ref={dialogRef} tabIndex={-1} className="confirm-dialog animate-scale-in" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={messageId} aria-busy={isLoading}>
      <div className="confirm-content">
        <div className={`confirm-icon confirm-icon-${type}`}><span className="material-symbols-rounded" aria-hidden="true">{ICONS[type]}</span></div>
        <h3 id={titleId}>{title}</h3>
        <div id={messageId} className="confirm-message">{message}</div>
      </div>
      <div className={`confirm-actions ${single?'confirm-actions-single':''}`}>
        {!single&&<button type="button" onClick={onCancel} disabled={isLoading} className="ui-button ui-button-quiet">{cancelLabel}</button>}
        <button type="button" onClick={onConfirm} disabled={isLoading} className={type==='danger'||type==='error'?'ui-button ui-button-danger':'ui-cta'}>{isLoading&&<span className="material-symbols-rounded ui-spin" aria-hidden="true">progress_activity</span>}{confirmLabel}</button>
      </div>
    </section>
  </div>;
};
export default ConfirmDialog;
