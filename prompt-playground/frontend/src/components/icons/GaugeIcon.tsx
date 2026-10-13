import type { IconProps } from './types'

export function GaugeIcon({ className = 'h-4 w-4', strokeWidth = 2 }: IconProps) {
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
      <path d="M12 14l4-4" /><path d="M3.3 19a10 10 0 1 1 17.4 0" />
    </svg>
  )
}
