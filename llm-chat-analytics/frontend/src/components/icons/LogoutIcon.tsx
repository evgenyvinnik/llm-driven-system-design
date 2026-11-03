import type { IconProps } from './types'

export function LogoutIcon({ className = 'h-4 w-4', title }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title && <title>{title}</title>}
      <path d="M14 5h4.5v14H14" /><path d="M10 8l-4 4 4 4" /><path d="M6 12h9" />
    </svg>
  )
}
