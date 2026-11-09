import type { IconProps } from './types'

export function ZapOffIcon({ className = 'h-4 w-4', title }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title && <title>{title}</title>}
      <path d="m13 2-3 4M18 14l1-1h-3M8 8l-4 6h7l-1 8 5-7M3 3l18 18" />
    </svg>
  )
}
