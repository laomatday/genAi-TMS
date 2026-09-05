import type { ButtonHTMLAttributes } from 'react';

type IconButtonSize = 'sm' | 'md' | 'lg';
type IconButtonTone = 'default' | 'inverse' | 'primary';

interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  icon: string;
  label: string;
  size?: IconButtonSize;
  tone?: IconButtonTone;
}

const IconButton = ({
  icon,
  label,
  size = 'md',
  tone = 'default',
  className = '',
  type = 'button',
  ...buttonProps
}: IconButtonProps) => (
  <button
    {...buttonProps}
    type={type}
    aria-label={label}
    className={`icon-button icon-button-${size} icon-button-${tone} ${className}`.trim()}
  >
    <span className="material-symbols-rounded" aria-hidden="true">{icon}</span>
  </button>
);

export default IconButton;
