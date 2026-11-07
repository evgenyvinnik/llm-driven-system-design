import type { IconProps } from './types'

export function WifiOffIcon({ className = 'h-4 w-4', title }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title && <title>{title}</title>}
      <path d="M2 2l20 20M8.5 16.5a5 5 0 0 1 7 0M5 13a10 10 0 0 1 5.2-2.8M14 10.2A10 10 0 0 1 19 13M2 9a15 15 0 0 1 4.5-2.9M11 5.1A15 15 0 0 1 22 9M12 20h.01" />
    </svg>
  )
}
