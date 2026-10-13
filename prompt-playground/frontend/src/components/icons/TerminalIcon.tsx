import type { IconProps } from './types'

export function TerminalIcon({ className = 'h-4 w-4', strokeWidth = 2 }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 17l6-6-6-6" /><path d="M12 19h8" />
    </svg>
  )
}
