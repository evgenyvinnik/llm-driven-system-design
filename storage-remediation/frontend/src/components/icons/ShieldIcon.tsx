import type { IconProps } from './types'

export function ShieldIcon({ className = 'h-4 w-4', title }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title && <title>{title}</title>}
      <path d="M12 3l8 3v6c0 5-3.4 8.6-8 9.9C7.4 20.6 4 17 4 12V6l8-3z" />
    </svg>
  )
}
