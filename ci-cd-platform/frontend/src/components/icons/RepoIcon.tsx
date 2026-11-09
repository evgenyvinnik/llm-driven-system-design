import type { IconProps } from './types'

export function RepoIcon({ className = 'h-4 w-4', title }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title && <title>{title}</title>}
      <path d="M5 4a2 2 0 0 1 2-2h12v17H7a2 2 0 0 0-2 2V4Z" /><path d="M5 19a2 2 0 0 1 2-2h12M9 7h6" />
    </svg>
  )
}
