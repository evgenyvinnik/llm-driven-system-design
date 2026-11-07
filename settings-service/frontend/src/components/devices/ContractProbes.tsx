import type { SettingsStore } from '@/lib/settings-store'
import type { SettingValue } from '@/types'

const PROBES: Array<{ label: string; key: string; value: SettingValue; expect: string }> = [
  { label: 'Old app writes a deprecated key', key: 'appearance.compact_mode', value: false, expect: '200 + warning, ignored' },
  { label: 'Write a retired key', key: 'notifications.sms_enabled', value: true, expect: '422 RETIRED' },
  { label: 'Write an unknown key', key: 'appearance.colour', value: 'teal', expect: '422 UNKNOWN_KEY' },
  { label: 'Write an out-of-range value', key: 'appearance.font_scale', value: 400, expect: '422 OUT_OF_RANGE' },
  { label: 'Write an enforced key', key: 'privacy.read_receipts', value: false, expect: '422 LOCKED' },
]

/** Sends requests the normal UI can't produce, through the phone's client, so every contract path is visible in its log. */
export function ContractProbes({ store }: { store: SettingsStore }) {
  return (
    <div className="card p-3">
      <p className="mb-2 text-sm font-medium text-ink">Contract probes (sent from the phone)</p>
      <div className="flex flex-wrap gap-2">
        {PROBES.map((p) => (
          <button
            key={p.key}
            type="button"
            className="btn-ghost flex-col items-start gap-0 text-left"
            data-probe={p.key}
            onClick={() => store.getState().set(p.key, p.value)}
          >
            <span className="text-xs font-medium">{p.label}</span>
            <span className="font-mono text-[10px] text-faint">expect {p.expect}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
