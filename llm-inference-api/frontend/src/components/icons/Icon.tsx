import type { ReactNode } from 'react'

export interface IconProps {
  className?: string
  /** 'outline' (default) strokes the path; 'solid' fills it. */
  variant?: 'outline' | 'solid'
}

export function Icon({ className = 'h-4 w-4', variant = 'outline', children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill={variant === 'solid' ? 'currentColor' : 'none'}
      stroke={variant === 'solid' ? 'none' : 'currentColor'}
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}
