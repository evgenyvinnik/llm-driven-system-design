import type { IconProps } from './types'

export function RefreshIcon({ className = 'h-4 w-4', title }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title && <title>{title}</title>}
      <path d="M19 12a7 7 0 1 1-2.05-4.95" /><path d="M19 4.5v4h-4" />
    </svg>
  )
}
