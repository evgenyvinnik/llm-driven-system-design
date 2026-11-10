import type { IconProps } from './types'

export function WebhookIcon({ className = 'h-4 w-4', title }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title && <title>{title}</title>}
      <path d="M9.5 16.5a3.5 3.5 0 1 1 1.6-6.6l2.6 4.6" /><path d="M14.5 16.5a3.5 3.5 0 1 0-1.4-6.7" /><path d="M12 5.5a3.5 3.5 0 0 1 3 5.3l-2.6 4.5" /><path d="M9.6 16.5h5" />
    </svg>
  )
}
