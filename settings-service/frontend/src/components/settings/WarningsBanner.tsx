import { useStore } from 'zustand'
import { InfoIcon } from '@/components/icons'
import type { SettingsStore } from '@/lib/settings-store'

/** Warnings from the last PATCH, e.g. a deprecated key that was accepted and ignored. */
export function WarningsBanner({ store }: { store: SettingsStore }) {
  const warnings = useStore(store, (s) => s.warnings)
  if (warnings.length === 0) return null
  return (
    <div className="card flex items-start gap-2 border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200" role="status">
      <InfoIcon className="mt-0.5 h-4 w-4 shrink-0" />
      <ul className="space-y-0.5">
        {warnings.map((w) => (
          <li key={w.key}>
            <span className="font-mono text-xs">{w.key}</span>: {w.message}
          </li>
        ))}
      </ul>
    </div>
  )
}
