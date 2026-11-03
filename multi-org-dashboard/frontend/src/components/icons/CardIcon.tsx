import type { IconProps } from './types'

export function CardIcon({ className = 'h-4 w-4', title }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title && <title>{title}</title>}
      <rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 10h18M7 15h3" />
    </svg>
  )
}
