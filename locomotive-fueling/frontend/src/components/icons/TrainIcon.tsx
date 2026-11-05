import type { IconProps } from './types'

export function TrainIcon({ className = 'h-4 w-4', title }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title && <title>{title}</title>}
      <rect x="5" y="3" width="14" height="14" rx="3" /><path d="M5 11h14M9 17l-2 4M15 17l2 4M8.5 14h.01M15.5 14h.01" />
    </svg>
  )
}
