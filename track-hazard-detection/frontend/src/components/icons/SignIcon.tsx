import type { IconProps } from './types'

export function SignIcon({ className = 'h-4 w-4', title }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title && <title>{title}</title>}
      <path d="M12 2 2 12l10 10 10-10L12 2zM12 8v5M12 16h.01" />
    </svg>
  )
}
