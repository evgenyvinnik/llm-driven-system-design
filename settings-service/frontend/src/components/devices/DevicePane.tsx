import { useStore } from 'zustand'
import { LaptopIcon, PhoneIcon, SnowflakeIcon } from '@/components/icons'
import { SettingRow } from '@/components/settings/SettingRow'
import { SyncPill } from '@/components/settings/SyncPill'
import type { SettingsStore } from '@/lib/settings-store'
import { DeviceLog } from './DeviceLog'

/** The settings this demo shows on each device: mixed types, one locked by policy. */
const DEMO_KEYS = [
  'appearance.theme',
  'notifications.email_digest',
  'regional.week_start',
  'notifications.push_enabled',
  'regional.language',
  'notifications.quiet_hours_start',
  'privacy.read_receipts',
]

interface Props {
  kind: 'phone' | 'laptop'
  label: string
  instanceHint: string
  store: SettingsStore
  orgName: string
}

export function DevicePane({ kind, label, instanceHint, store, orgName }: Props) {
  const definitions = useStore(store, (s) => s.definitions)
  const settings = useStore(store, (s) => s.doc?.settings)
  const pending = useStore(store, (s) => s.pending)
  const flash = useStore(store, (s) => s.flash)
  const live = useStore(store, (s) => s.live)
  const actions = store.getState()
  const Icon = kind === 'phone' ? PhoneIcon : LaptopIcon
  const frozen = live === 'frozen'
  const defs = DEMO_KEYS.map((k) => definitions.find((d) => d.key === k)).filter((d) => d !== undefined)

  return (
    <section className={`card flex min-w-0 flex-col overflow-hidden ${frozen ? 'ring-2 ring-sky-300 dark:ring-sky-500/40' : ''}`} data-device={kind} aria-label={label}>
      <header className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        <Icon className="h-5 w-5 text-accent-600" />
        <div className="mr-auto leading-tight">
          <h2 className="text-sm font-semibold text-ink">{label}</h2>
          <p className="text-[11px] text-muted">{instanceHint}</p>
        </div>
        <SyncPill store={store} />
        <button
          type="button"
          className={frozen ? 'btn-primary px-2 py-1 text-xs' : 'btn-ghost px-2 py-1 text-xs'}
          onClick={() => actions.setFrozen(!frozen)}
          data-action="freeze"
          title="Simulate a backgrounded app: no SSE, no refetch, but writes still go out with its old revision"
        >
          <SnowflakeIcon className="h-3.5 w-3.5" />
          {frozen ? 'Unfreeze' : 'Freeze sync'}
        </button>
      </header>
      <div className="divide-y divide-line">
        {defs.map((def) => (
          <SettingRow
            key={def.key}
            def={def}
            entry={settings?.[def.key]}
            pending={pending[def.key]}
            orgName={orgName}
            flashAt={flash[def.key]}
            dense
            onChange={(v) => actions.set(def.key, v)}
            onResolve={(c) => actions.resolveConflict(def.key, c)}
            onDismiss={() => actions.dismiss(def.key)}
          />
        ))}
      </div>
      <div className="mt-auto">
        <DeviceLog store={store} />
      </div>
    </section>
  )
}
