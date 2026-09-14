import React from 'react';
import { getAvatarHtml } from '@/core/utils/helpers';

interface Props {
  src?: string;
  name: string;
  className?: string;
  textSize?: string;
}

const Avatar: React.FC<Props> = ({ src, name, className = "w-10 h-10", textSize = "text-xs" }) => {
  const avatarData = getAvatarHtml(name, src || "");
  const commonClasses = `rounded-full shadow-sm flex-shrink-0 ${className}`;
  if (avatarData.type === 'img') return <img src={avatarData.src} alt={name} className={`${commonClasses} avatar-image`} loading="lazy" />;
  return <div className={`${commonClasses} avatar-initials ${textSize}`}>{avatarData.text}</div>;
};
export default Avatar;
