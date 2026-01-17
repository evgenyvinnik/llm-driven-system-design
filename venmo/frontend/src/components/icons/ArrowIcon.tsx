/**
 * Arrow icon component for indicating transaction direction (sent/received).
 * Displays an upward arrow for sent transactions or downward arrow for received.
 */
interface ArrowIconProps {
  /** Additional CSS classes to apply */
  className?: string;
  /** Direction of the arrow - 'up-right' for sent, 'down-left' for received */
  direction: 'up-right' | 'down-left';
}

/**
 * Renders an arrow icon indicating the direction of a transaction.
 * Used in transaction history to visually differentiate sent vs received payments.
 */
export function ArrowIcon({ className = 'w-5 h-5', direction }: ArrowIconProps) {
  const path =
    direction === 'up-right'
      ? 'M4.5 19.5l15-15m0 0H8.25m11.25 0v11.25'
      : 'M19.5 4.5l-15 15m0 0h11.25m-11.25 0V8.25';

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={2}
      stroke="currentColor"
      className={className}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d={path} />
    </svg>
  );
}
