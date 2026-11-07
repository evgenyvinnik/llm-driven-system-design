import type { IconProps } from './types'

export function ChartIcon({ className = 'h-4 w-4', title }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title && <title>{title}</title>}
      <path d="M3 3v18h18" /><path d="M7 15v2M11 11v6M15 7v10M19 12v5" />
    </svg>
  )
}
