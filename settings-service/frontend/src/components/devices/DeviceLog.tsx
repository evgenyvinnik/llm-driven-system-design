import { useStore } from 'zustand'
import { clockTime } from '@/lib/display'
import type { LogEntry, SettingsStore } from '@/lib/settings-store'

const TONE: Record<LogEntry['tone'], string> = {
  info: 'text-muted',
  ok: 'text-emerald-700 dark:text-emerald-300',
  warn: 'text-amber-700 dark:text-amber-300',
  error: 'text-red-700 dark:text-red-300',
  event: 'text-accent-700 dark:text-accent-100',
}

/** What this device's client did and saw, newest first. */
export function DeviceLog({ store }: { store: SettingsStore }) {
  const log = useStore(store, (s) => s.log)
  return (
    <div className="border-t border-line bg-sunken/40 px-4 py-3">
      <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-faint">Sync log</h3>
      {log.length === 0 ? (
        <p className="text-xs text-faint">Nothing yet. Change a setting on either device.</p>
      ) : (
        <ol className="max-h-56 space-y-1 overflow-y-auto font-mono text-[11px] leading-snug" aria-label="Sync log">
          {log.map((e) => (
            <li key={e.id} className={TONE[e.tone]}>
              <span className="text-faint">{clockTime(e.at)}</span> {e.text}
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
