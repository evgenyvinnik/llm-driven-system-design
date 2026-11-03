import type { IconProps } from './types'

export function SpinnerIcon({ className = 'h-4 w-4', title }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={`animate-spin motion-reduce:animate-none ${className}`} aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title && <title>{title}</title>}
      <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeOpacity={0.2} strokeWidth={2.5} />
      <path d="M20.5 12a8.5 8.5 0 0 0-8.5-8.5" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" />
    </svg>
  )
}
