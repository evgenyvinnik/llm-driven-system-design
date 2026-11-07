import type { IconProps } from './types'

/** Three parallel flows: the broker streams. */
export function StreamIcon({ className = 'h-4 w-4', title }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title && <title>{title}</title>}
      <path d="M3 7h12M3 12h18M3 17h9" /><path d="m13 4 3 3-3 3M18 9l3 3-3 3M10 14l3 3-3 3" />
    </svg>
  )
}
