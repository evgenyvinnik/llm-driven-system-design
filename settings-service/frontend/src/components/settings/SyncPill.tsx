import { useStore } from 'zustand'
import { SnowflakeIcon, WifiIcon, WifiOffIcon } from '@/components/icons'
import type { SettingsStore } from '@/lib/settings-store'

const LABEL = { off: 'offline', connecting: 'connecting', live: 'live', reconnecting: 'reconnecting', frozen: 'frozen' } as const

/** Revision held, live-connection state and which API instance the SSE stream is on. */
export function SyncPill({ store }: { store: SettingsStore }) {
  const live = useStore(store, (s) => s.live)
  const revision = useStore(store, (s) => s.doc?.revision)
  const orgRevision = useStore(store, (s) => s.doc?.orgRevision)
  const instanceId = useStore(store, (s) => s.instanceId)
  const tone =
    live === 'live'
      ? 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/30'
      : live === 'frozen'
        ? 'bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-500/10 dark:text-sky-300 dark:ring-sky-500/30'
        : 'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/30'
  const Icon = live === 'live' ? WifiIcon : live === 'frozen' ? SnowflakeIcon : WifiOffIcon
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ${tone}`} data-live={live} data-revision={revision ?? ''}>
      <Icon className="h-3.5 w-3.5" />
      <span className="font-mono">r{revision ?? '–'}</span>
      <span className="opacity-60">·</span>
      <span>{LABEL[live]}</span>
      {instanceId && live === 'live' && <span className="opacity-70">via {instanceId}</span>}
      {orgRevision !== undefined && <span className="hidden font-mono opacity-60 sm:inline">org r{orgRevision}</span>}
    </span>
  )
}
