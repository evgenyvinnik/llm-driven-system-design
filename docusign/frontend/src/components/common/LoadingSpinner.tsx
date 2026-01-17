/**
 * Loading spinner component for indicating loading states.
 * Displays a circular animated spinner with optional sizing and centering.
 *
 * @param props - Component props
 * @param props.size - Size variant: 'sm', 'md', or 'lg'
 * @param props.centered - Whether to center the spinner in a flex container
 * @param props.message - Optional loading message to display below the spinner
 * @returns A spinning loader element
 */
interface LoadingSpinnerProps {
  /** Size of the spinner */
  size?: 'sm' | 'md' | 'lg';
  /** Center the spinner in a flex container */
  centered?: boolean;
  /** Optional message to display */
  message?: string;
}

/** Size class mappings */
const SIZE_CLASSES: Record<string, string> = {
  sm: 'w-4 h-4 border-2',
  md: 'w-8 h-8 border-4',
  lg: 'w-12 h-12 border-4',
};

export function LoadingSpinner({
  size = 'md',
  centered = false,
  message,
}: LoadingSpinnerProps) {
  const sizeClass = SIZE_CLASSES[size];

  const spinner = (
    <div
      className={`${sizeClass} border-gray-300 border-t-docusign-blue rounded-full spinner`}
    />
  );

  if (centered) {
    return (
      <div className="flex flex-col items-center justify-center h-64">
        {spinner}
        {message && <p className="text-gray-600 mt-4">{message}</p>}
      </div>
    );
  }

  return spinner;
}
