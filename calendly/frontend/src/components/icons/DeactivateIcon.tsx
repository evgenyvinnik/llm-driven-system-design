/**
 * Props for icon components.
 */
interface IconProps {
  /** Additional CSS classes to apply */
  className?: string;
}

/**
 * Deactivate icon showing a crossed-out circle.
 * Used to indicate an action to deactivate or disable something.
 * @param props - Component props
 */
export function DeactivateIcon({ className = 'w-5 h-5' }: IconProps) {
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
        d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"
      />
    </svg>
  );
}
