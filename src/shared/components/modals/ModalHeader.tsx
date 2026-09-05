import React from 'react';
import IconButton from '@/shared/components/common/IconButton';

interface Props {
  title?: string;
  onClose: () => void;
  rightContent?: React.ReactNode;
  bgClass?: string;
}

const ModalHeader: React.FC<Props> = ({ title, onClose, rightContent, bgClass }) => (
  <div className={`app-modal-header ${bgClass || ''}`}>
    <div className="app-modal-header-inner">
      <div className="app-modal-header-title">
        {title && <h2 className="animate-fade-in">{title}</h2>}
      </div>
      <div className="app-modal-header-actions">
        {rightContent}
        <IconButton
          icon="close"
          label="Đóng"
          onClick={onClose}
        />
      </div>
    </div>
  </div>
);

export default ModalHeader;
