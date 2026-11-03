import type { IconProps } from './types'

export function BotIcon({ className = 'h-4 w-4', title }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title && <title>{title}</title>}
      <rect x="4" y="8" width="16" height="12" rx="3" /><path d="M12 8V4M8 13h.01M16 13h.01M9 17h6" />
    </svg>
  )
}
