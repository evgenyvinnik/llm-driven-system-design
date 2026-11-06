import type { IconProps } from './types'

export function AlertIcon({ className = 'h-4 w-4', title }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title && <title>{title}</title>}
      <path d="M12 3 2.5 20h19L12 3z" /><path d="M12 10v4M12 17v.5" />
    </svg>
  )
}
