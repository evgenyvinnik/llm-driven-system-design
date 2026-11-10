import type { IconProps } from './types'

export function GaugeIcon({ className = 'h-4 w-4', title }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title && <title>{title}</title>}
      <path d="M4 18a9 9 0 1 1 16 0" /><path d="m12 14 4-5" /><circle cx="12" cy="15" r="1.5" />
    </svg>
  )
}
