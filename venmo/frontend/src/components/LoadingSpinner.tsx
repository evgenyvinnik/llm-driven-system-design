/**
 * Loading spinner component for indicating async operations.
 * Displays a centered animated spinner.
 */

import { SpinnerIcon } from './icons';

/**
 * Props for the LoadingSpinner component.
 */
interface LoadingSpinnerProps {
  /** Additional CSS classes for the container */
  className?: string;
}

/**
 * Renders a centered loading spinner.
 * Used while data is being fetched or an operation is in progress.
 */
export function LoadingSpinner({ className = 'py-8' }: LoadingSpinnerProps) {
  return (
    <div className={`text-center ${className}`}>
      <SpinnerIcon className="h-8 w-8 border-venmo-blue mx-auto" />
    </div>
  );
}
