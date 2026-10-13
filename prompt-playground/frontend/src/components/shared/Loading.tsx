import { SpinnerIcon } from '@/components/icons'

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-sm text-slate-500">
      <SpinnerIcon className="h-4 w-4 animate-spin" />
      {label}…
    </div>
  )
}
