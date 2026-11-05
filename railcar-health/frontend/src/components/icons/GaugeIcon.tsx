import type { IconProps } from './types'

export function GaugeIcon({ className = 'h-4 w-4', title }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title && <title>{title}</title>}
      <path d="M12 14l4-4" /><path d="M3.3 19a10 10 0 1 1 17.4 0" />
    </svg>
  )
}
