import { TIER_NAMES, TIER_STYLE } from '@/lib/tiers'
import type { Network } from '@/types'

export interface AlertFilterState {
  tier?: number
  territory?: string
  status: 'active' | 'closed' | 'all'
  late?: boolean
}

interface Props {
  value: AlertFilterState
  counts: Record<string, number>
  network: Network | null
  onChange: (next: AlertFilterState) => void
}

export function AlertFilters({ value, counts, network, onChange }: Props) {
  const total = Object.values(counts).reduce((s, n) => s + n, 0)
  const tab = (active: boolean) =>
    `flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium ${active ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'}`
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Risk tier">
        <button type="button" role="tab" aria-selected={!value.tier} className={tab(!value.tier)} onClick={() => onChange({ ...value, tier: undefined })}>
          All <span className="text-xs opacity-70">{total}</span>
        </button>
        {[4, 3, 2, 1].map((t) => (
          <button key={t} type="button" role="tab" aria-selected={value.tier === t} className={tab(value.tier === t)} onClick={() => onChange({ ...value, tier: t })}>
            <span className={`h-2.5 w-2.5 rounded-full ${TIER_STYLE[t].dot}`} aria-hidden />
            {TIER_NAMES[t]} <span className="text-xs opacity-70">{counts[t] ?? 0}</span>
          </button>
        ))}
      </div>
      <div className="flex-1" />
      <select
        aria-label="Territory"
        className="input w-auto"
        value={value.territory ?? ''}
        onChange={(e) => onChange({ ...value, territory: e.target.value || undefined })}
      >
        <option value="">All territories</option>
        {network?.desks.map((d) => (
          <option key={d.id} value={d.id}>{d.name}</option>
        ))}
        {network?.subdivisions.map((s) => (
          <option key={s.id} value={s.id}>{s.name} (MP {s.startMp}–{s.endMp})</option>
        ))}
      </select>
      <select aria-label="Status" className="input w-auto" value={value.status} onChange={(e) => onChange({ ...value, status: e.target.value as AlertFilterState['status'] })}>
        <option value="active">Open and acknowledged</option>
        <option value="closed">Closed</option>
        <option value="all">All</option>
      </select>
      <label className="flex items-center gap-1.5 text-sm text-slate-600">
        <input type="checkbox" checked={value.late ?? false} onChange={(e) => onChange({ ...value, late: e.target.checked || undefined })} />
        Late data only
      </label>
    </div>
  )
}
