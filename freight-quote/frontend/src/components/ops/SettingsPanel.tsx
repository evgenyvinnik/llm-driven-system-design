import { api } from '@/services/api'
import type { Settings } from '@/types'

interface Toggle {
  label: string
  hint: string
  on: boolean
  patch: (on: boolean) => Record<string, unknown>
}

/** Runtime switches for the quote path, shared by every API instance through Valkey. */
export function SettingsPanel({ settings, onChange }: { settings: Settings; onChange: () => void }) {
  const toggles: Toggle[] = [
    { label: 'Hedged requests', hint: `to ${settings.hedging.deps.join(', ')} after p${settings.hedging.percentile}, max ${settings.hedging.budgetPct}% of calls`, on: settings.hedging.enabled, patch: (on) => ({ hedging: { enabled: on } }) },
    { label: 'Request coalescing', hint: 'identical in-flight dependency calls share one', on: settings.coalescing, patch: (on) => ({ coalescing: on }) },
    { label: 'Deadline propagation', hint: 'send X-Deadline so dependencies stop abandoned work', on: settings.propagateDeadline, patch: (on) => ({ propagateDeadline: on }) },
    { label: 'Load shedding', hint: `max ${settings.shedding.maxInflight} in flight per instance`, on: settings.shedding.enabled, patch: (on) => ({ shedding: { enabled: on } }) },
    { label: 'Per-customer rate limits', hint: `portal ${settings.rateLimits.portalPerMinute}/min, API ${settings.rateLimits.apiPerMinute}/min unless the contract says otherwise`, on: settings.rateLimits.enabled, patch: (on) => ({ rateLimits: { enabled: on } }) },
  ]
  const save = async (patch: Record<string, unknown>) => {
    await api.updateSettings(patch)
    onChange()
  }
  return (
    <section className="card p-4" aria-label="Quote path settings">
      <div className="mb-3 flex items-center justify-between">
        <div className="panel-title">Quote path</div>
        <button type="button" className="btn-ghost text-xs" onClick={() => void api.resetSettings().then(onChange)}>
          Reset
        </button>
      </div>
      <label className="mb-3 flex items-center justify-between gap-2 text-sm">
        <span>
          Overall deadline <span className="text-xs text-slate-500">(budgets {Object.values(settings.budgets).join(' / ')} ms)</span>
        </span>
        <select className="input w-28" value={settings.deadlineMs} onChange={(e) => void save({ deadlineMs: Number(e.target.value) })}>
          {[300, 600, 900, 1500, 3000].map((v) => (
            <option key={v} value={v}>{v} ms</option>
          ))}
        </select>
      </label>
      <ul className="space-y-2.5">
        {toggles.map((t) => (
          <li key={t.label} className="flex items-start justify-between gap-3">
            <div>
              <div className="text-sm font-medium text-slate-800">{t.label}</div>
              <div className="text-xs text-slate-500">{t.hint}</div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={t.on}
              aria-label={t.label}
              onClick={() => void save(t.patch(!t.on))}
              className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors ${t.on ? 'bg-accent-600' : 'bg-slate-300'}`}
            >
              <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${t.on ? 'left-[18px]' : 'left-0.5'}`} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
