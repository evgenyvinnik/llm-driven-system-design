/**
 * Loading spinner icon component for indicating async operations.
 */
interface SpinnerIconProps {
  /** Additional CSS classes to apply */
  className?: string;
}

/**
 * Renders an animated loading spinner.
 * Used to indicate that data is being loaded or an operation is in progress.
 */
export function SpinnerIcon({ className = 'h-8 w-8 border-venmo-blue' }: SpinnerIconProps) {
  return (
    <div className={`animate-spin rounded-full border-b-2 ${className}`}></div>
  );
}
