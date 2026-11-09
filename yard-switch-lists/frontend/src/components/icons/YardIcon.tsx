import type { IconProps } from './types'

export function YardIcon({ className = 'h-4 w-4', title }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title && <title>{title}</title>}
      <path d="M4 21 10 3M20 21 14 3M6 15h12M7.5 10h9M9 5.5h6" />
    </svg>
  )
}
