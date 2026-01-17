/**
 * Props for icon components.
 */
interface IconProps {
  /** Additional CSS classes to apply */
  className?: string;
}

/**
 * Calendar icon for meeting-related UI elements.
 * Used in empty states and meeting type cards.
 * @param props - Component props
 */
export function CalendarIcon({ className = 'w-6 h-6' }: IconProps) {
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
        d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
      />
    </svg>
  );
}
