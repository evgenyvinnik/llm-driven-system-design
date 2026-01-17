/**
 * Props for the LoadingSpinner component.
 */
interface LoadingSpinnerProps {
  /** Size variant: 'sm' (16px), 'md' (32px), or 'lg' (48px) */
  size?: 'sm' | 'md' | 'lg';
  /** Additional CSS classes to apply */
  className?: string;
}

/**
 * Animated loading spinner component.
 * Displays a circular spinner for loading states.
 * Centered within its container by default.
 * @param props - Component props
 */
export function LoadingSpinner({ size = 'md', className = '' }: LoadingSpinnerProps) {
  const sizeClasses = {
    sm: 'w-4 h-4',
    md: 'w-8 h-8',
    lg: 'w-12 h-12',
  };

  return (
    <div className={`flex justify-center items-center ${className}`}>
      <div
        className={`${sizeClasses[size]} border-4 border-primary-200 border-t-primary-600 rounded-full animate-spin`}
      />
    </div>
  );
}
