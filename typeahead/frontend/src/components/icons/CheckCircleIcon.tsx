/**
 * CheckCircleIcon - A circular checkmark icon for success states.
 * Used to indicate healthy or successful status.
 */
interface CheckCircleIconProps {
  className?: string;
}

export function CheckCircleIcon({ className = 'w-6 h-6' }: CheckCircleIconProps) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
      />
    </svg>
  );
}
