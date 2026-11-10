import { SpinnerIcon } from '@/components/icons'

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <main className="flex min-h-[40vh] items-center justify-center gap-2 text-sm text-slate-500">
      <SpinnerIcon /> {label}
    </main>
  )
}
