import type { IconProps } from './types'

export function StreamIcon({ className = 'h-4 w-4', title }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title && <title>{title}</title>}
      <path d="M3 6h12M3 12h18M3 18h8" /><circle cx="18" cy="6" r="2" /><circle cx="14" cy="18" r="2" />
    </svg>
  )
}
