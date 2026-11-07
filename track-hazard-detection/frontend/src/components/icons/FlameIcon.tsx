import type { IconProps } from './types'

export function FlameIcon({ className = 'h-4 w-4', title }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title && <title>{title}</title>}
      <path d="M12 3s5 4.5 5 9.5A5 5 0 0 1 7 12.5C7 10 8.5 8.5 9 7c.5 2 2 3 2 3s-.5-4 1-7z" />
    </svg>
  )
}
