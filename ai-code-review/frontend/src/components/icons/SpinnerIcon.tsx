import type { IconProps } from './types'

export function SpinnerIcon({ className = 'h-4 w-4 animate-spin', title }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title && <title>{title}</title>}
      <path d="M21 12a9 9 0 1 1-6.2-8.6" />
    </svg>
  )
}
