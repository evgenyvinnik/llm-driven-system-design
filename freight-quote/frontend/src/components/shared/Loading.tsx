import { SpinnerIcon } from '@/components/icons'

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex h-full min-h-40 items-center justify-center gap-2 text-sm text-slate-500">
      <SpinnerIcon /> {label}…
    </div>
  )
}

export function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null
  return <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{message}</div>
}
