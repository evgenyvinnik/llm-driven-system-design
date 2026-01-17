/**
 * Loading spinner component.
 * Displays an animated circular spinner to indicate loading state.
 *
 * @param props.size - Size variant: 'sm' (8x8), 'md' (12x12), or 'lg' (12x12 with border-4)
 * @param props.className - Additional CSS classes to apply
 * @returns Animated loading spinner element
 */
interface LoadingSpinnerProps {
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

export function LoadingSpinner({ size = 'md', className = '' }: LoadingSpinnerProps) {
  const sizeClasses = {
    sm: 'h-8 w-8 border-b-2',
    md: 'h-12 w-12 border-b-2',
    lg: 'h-12 w-12 border-b-4',
  };

  return (
    <div className={`animate-spin rounded-full ${sizeClasses[size]} border-indigo-600 ${className}`} />
  );
}

/**
 * Full-page loading spinner centered on screen.
 * Used for initial page loads and route transitions.
 *
 * @param props.bgColor - Background color class, defaults to 'bg-gray-100'
 * @returns Full-page centered loading spinner
 */
interface PageLoadingSpinnerProps {
  bgColor?: string;
}

export function PageLoadingSpinner({ bgColor = 'bg-gray-100' }: PageLoadingSpinnerProps) {
  return (
    <div className={`min-h-screen flex items-center justify-center ${bgColor}`}>
      <LoadingSpinner size="md" />
    </div>
  );
}

/**
 * Inline loading spinner for content areas.
 * Used within content sections that are loading.
 *
 * @returns Centered loading spinner with padding
 */
export function ContentLoadingSpinner() {
  return (
    <div className="flex justify-center py-12">
      <LoadingSpinner size="sm" />
    </div>
  );
}
