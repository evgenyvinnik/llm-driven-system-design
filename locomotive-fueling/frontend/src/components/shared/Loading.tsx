import { SpinnerIcon, WifiOffIcon } from '@/components/icons'

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

/** Shown when a page is serving its last good copy because the network is down. */
export function StaleBanner({ fetchedAt, error }: { fetchedAt: number | null; error: string | null }) {
  const minutes = fetchedAt ? Math.round((Date.now() - fetchedAt) / 60_000) : null
  return (
    <div className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900" role="status">
      <WifiOffIcon className="h-4 w-4" />
      Offline{error ? ` (${error})` : ''}. Showing the plan as of {minutes === null ? 'an earlier visit' : minutes < 1 ? 'less than a minute ago' : `${minutes} min ago`}; it will refresh when the connection returns.
    </div>
  )
}
