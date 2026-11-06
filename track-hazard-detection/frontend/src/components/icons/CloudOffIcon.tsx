import type { IconProps } from './types'

export function CloudOffIcon({ className = 'h-4 w-4', title }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title && <title>{title}</title>}
      <path d="M3 3l18 18M8 8a5 5 0 0 0-1 9.9h10M17.5 17.5A4 4 0 0 0 16.6 10 6 6 0 0 0 10 5.3" />
    </svg>
  )
}
