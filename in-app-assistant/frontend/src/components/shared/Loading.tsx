import { SpinnerIcon } from '@/components/icons'

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 p-6 text-sm text-slate-500">
      <SpinnerIcon /> {label}
    </div>
  )
}

export function ErrorNote({ message }: { message: string }) {
  return <div className="m-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{message}</div>
}
