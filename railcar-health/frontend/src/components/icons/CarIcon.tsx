import type { IconProps } from './types'

export function CarIcon({ className = 'h-4 w-4', title }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title && <title>{title}</title>}
      <path d="M3 7h18v7H3zM6 14v1M18 14v1" /><circle cx="7" cy="17.5" r="2" /><circle cx="17" cy="17.5" r="2" />
    </svg>
  )
}
