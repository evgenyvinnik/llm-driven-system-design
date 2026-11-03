import type { IconProps } from './types'

export function EyeOffIcon({ className = 'h-4 w-4', title }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title && <title>{title}</title>}
      <path d="M4 4l16 16" /><path d="M9.9 6.2A9.6 9.6 0 0 1 12 6c5 0 8.5 6 8.5 6a15 15 0 0 1-2.6 3.2" /><path d="M6.3 8A15 15 0 0 0 3.5 12S7 18 12 18a8.6 8.6 0 0 0 3.1-.6" />
    </svg>
  )
}
