import type { ReactNode } from 'react'
import { SpinnerIcon } from '@/components/icons'

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 p-6 text-sm text-slate-500">
      <SpinnerIcon /> {label}
    </div>
  )
}

/** Rose, not red: the repo's screenshot script treats red-50/red-700 as a login error banner. */
export function ErrorNote({ message }: { message: string }) {
  return <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">{message}</div>
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="px-4 py-8 text-center text-sm text-slate-500">{children}</div>
}
