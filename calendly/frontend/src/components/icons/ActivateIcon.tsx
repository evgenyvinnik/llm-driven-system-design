/**
 * Props for icon components.
 */
interface IconProps {
  /** Additional CSS classes to apply */
  className?: string;
}

/**
 * Activate icon showing a checkmark inside a circle.
 * Used to indicate an action to activate or enable something.
 * @param props - Component props
 */
export function ActivateIcon({ className = 'w-5 h-5' }: IconProps) {
  return (
    <svg
      className={className}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
      />
    </svg>
  );
}
