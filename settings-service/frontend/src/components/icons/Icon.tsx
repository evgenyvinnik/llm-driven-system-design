import type { ReactNode } from 'react'
import type { IconProps } from './types'

/** Shared 24×24 stroke icon frame; each icon file supplies only its paths. */
export function Icon({ className = 'h-4 w-4', title, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
    >
      {title && <title>{title}</title>}
      {children}
    </svg>
  )
}
