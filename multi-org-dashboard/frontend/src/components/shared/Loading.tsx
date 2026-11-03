import { SpinnerIcon } from '@/components/icons'

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 p-6 text-sm text-slate-500" role="status">
      <SpinnerIcon />
      {label}
    </div>
  )
}
