import { SpinnerIcon } from '@/components/icons'

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex min-h-[40vh] items-center justify-center gap-2 text-sm text-muted" role="status">
      <SpinnerIcon className="h-5 w-5" /> {label}
    </div>
  )
}
