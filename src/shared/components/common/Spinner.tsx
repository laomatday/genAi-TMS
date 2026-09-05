interface Props { size?: 'sm'|'md'|'lg'|'xl'; className?: string; }
const Spinner = ({ size='md', className='' }: Props) => {
  return <span className={`app-spinner app-spinner-${size} ${className}`.trim()} aria-hidden="true" />;
};
export default Spinner;
