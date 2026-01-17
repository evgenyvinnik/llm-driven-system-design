import React from 'react';

/**
 * Props for the LoadingSpinner component.
 */
export interface LoadingSpinnerProps {
  /** Size of the spinner (defaults to 'medium') */
  size?: 'small' | 'medium' | 'large';
  /** Optional additional CSS classes */
  className?: string;
}

/**
 * Size class mappings for the spinner.
 */
const sizeClasses = {
  small: 'h-4 w-4',
  medium: 'h-8 w-8',
  large: 'h-12 w-12',
};

/**
 * Displays an animated loading spinner.
 *
 * Used throughout the application to indicate loading states.
 * The spinner is a circular animation with a spinning border effect.
 *
 * @example
 * ```tsx
 * <LoadingSpinner />
 * <LoadingSpinner size="large" />
 * ```
 *
 * @param props - Component props
 * @returns Animated spinner element
 */
export const LoadingSpinner: React.FC<LoadingSpinnerProps> = ({
  size = 'medium',
  className = '',
}) => {
  return (
    <div
      className={`animate-spin rounded-full border-b-2 border-blue-500 ${sizeClasses[size]} ${className}`}
    />
  );
};

/**
 * Props for the CenteredSpinner component.
 */
export interface CenteredSpinnerProps extends LoadingSpinnerProps {
  /** Height of the container (defaults to 'h-64') */
  height?: string;
}

/**
 * Displays a centered loading spinner within a container.
 *
 * Useful for loading states that need to fill a specific area,
 * such as page content or modal bodies.
 *
 * @example
 * ```tsx
 * <CenteredSpinner />
 * <CenteredSpinner height="h-32" size="small" />
 * ```
 *
 * @param props - Component props
 * @returns Centered spinner within a flex container
 */
export const CenteredSpinner: React.FC<CenteredSpinnerProps> = ({
  height = 'h-64',
  ...spinnerProps
}) => {
  return (
    <div className={`flex items-center justify-center ${height}`}>
      <LoadingSpinner {...spinnerProps} />
    </div>
  );
};
