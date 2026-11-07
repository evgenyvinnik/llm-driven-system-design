import type { IconProps } from './types'

export function LibraryIcon({ className = 'h-4 w-4', title }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title && <title>{title}</title>}
      <path d="M4 5h5v14H4zM10 5h5v14h-5zM16 6l3.5-1 2 13.5-3.5 1z" />
    </svg>
  )
}
