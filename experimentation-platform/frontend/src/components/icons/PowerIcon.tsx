import type { IconProps } from './types'

export function PowerIcon({ className = 'h-4 w-4', title }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title && <title>{title}</title>}
      <path d="M12 2v10" /><path d="M18.4 6.6a9 9 0 1 1-12.8 0" />
    </svg>
  )
}
