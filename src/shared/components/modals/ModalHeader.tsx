import React from 'react';
import IconButton from '@/shared/components/common/IconButton';

interface Props {
  title?: string;
  /** Optional caption under the title, e.g. which record the sheet is showing. */
  subtitle?: string;
  onClose: () => void;
  /** When given, the sheet gets a leading back affordance and centres its title. */
  onBack?: () => void;
  rightContent?: React.ReactNode;
  bgClass?: string;
}

const ModalHeader: React.FC<Props> = ({ title, subtitle, onClose, onBack, rightContent, bgClass }) => (
  <div className={`app-modal-header ${bgClass || ''}`}>
    <div className={`app-modal-header-inner ${onBack ? 'app-modal-header-inner-centered' : ''}`}>
      {onBack ? (
        <div className="app-modal-header-lead">
          <IconButton icon="arrow_back" label="Quay lại" onClick={onBack} />
        </div>
      ) : null}

      <div className="app-modal-header-title">
        {title ? <h2 className="animate-fade-in">{title}</h2> : null}
        {subtitle ? <p>{subtitle}</p> : null}
      </div>

      <div className="app-modal-header-actions">
        {rightContent}
        <IconButton icon="close" label="Đóng" onClick={onClose} />
      </div>
    </div>
  </div>
);

export default ModalHeader;
