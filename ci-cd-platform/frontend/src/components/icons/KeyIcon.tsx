import type { IconProps } from './types'

export function KeyIcon({ className = 'h-4 w-4', title }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title && <title>{title}</title>}
      <circle cx="8" cy="15" r="4" /><path d="m11 12 9-9M16 7l3 3M13 10l2 2" />
    </svg>
  )
}
