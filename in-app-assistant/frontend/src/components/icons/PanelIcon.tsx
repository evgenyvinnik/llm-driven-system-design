import type { IconProps } from './types'

export function PanelIcon({ className = 'h-4 w-4', title }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title && <title>{title}</title>}
      <rect x="3" y="3" width="18" height="18" rx="2" /><path d="M15 3v18" />
    </svg>
  )
}
