import { SpinnerIcon } from '@/components/icons'

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <main className="flex items-center gap-2 p-6 text-sm text-slate-500">
      <SpinnerIcon /> {label}
    </main>
  )
}

export function ErrorNote({ message }: { message: string }) {
  return <div className="rounded-md border border-rose-300 bg-rose-100 px-3 py-2 text-sm text-rose-900">{message}</div>
}
