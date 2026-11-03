/**
 * One row of filters above the charts. Every control writes to the URL;
 * nothing here holds state of its own.
 */
import type { Meta } from '../../lib/api'
import { allowedGrains, toggle, type Compare, type DashboardSearch, type Grain, type Range, type ResolvedQuery } from '../../lib/filters'
import { FEATURE_LABELS } from '../../lib/format'
import { CloseIcon } from '../icons'

const RANGE_LABELS: Record<Range, string> = { '1h': '1 h', today: 'Today', '24h': '24 h', '7d': '7 days', '28d': '28 days', mtd: 'Month to date', custom: 'Custom' }
const COMPARE_LABELS: Record<Compare, string> = { none: 'No comparison', wow: 'vs previous week', mom: 'vs previous month' }

interface Props {
  search: DashboardSearch
  resolved: ResolvedQuery | null
  meta: Meta | undefined
  onChange: (patch: Partial<DashboardSearch>, opts?: { replace?: boolean }) => void
  children?: React.ReactNode
}

export function FilterBar({ search, resolved, meta, onChange, children }: Props) {
  const grains = resolved ? allowedGrains(Date.parse(resolved.from), Date.parse(resolved.to)) : []
  const activeChips = [...search.models.map((m) => ({ dim: 'models' as const, key: m, label: m })), ...search.features.map((f) => ({ dim: 'features' as const, key: f, label: FEATURE_LABELS[f] ?? f }))]
  return (
    <div className="card space-y-3 p-3" data-testid="filter-bar">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap rounded-md border text-xs" style={{ borderColor: 'var(--border)' }} role="group" aria-label="Date range">
          {(Object.keys(RANGE_LABELS) as Range[]).map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => onChange({ range: r, grain: undefined, drill: undefined })}
              aria-pressed={search.range === r}
              className={`px-2.5 py-1.5 ${search.range === r ? 'bg-series-1 font-medium text-white' : 'text-ink-2 hover:bg-plane'}`}
            >
              {RANGE_LABELS[r]}
            </button>
          ))}
        </div>
        {search.range === 'custom' && (
          <span className="flex items-center gap-1 text-xs">
            <input type="date" className="input w-auto py-1 text-xs" value={search.from ?? ''} onChange={(e) => onChange({ from: e.target.value, drill: undefined })} aria-label="From date" />
            <span className="text-ink-muted">to</span>
            <input type="date" className="input w-auto py-1 text-xs" value={search.to ?? ''} onChange={(e) => onChange({ to: e.target.value, drill: undefined })} aria-label="To date" />
          </span>
        )}
        <select className="input w-auto py-1 text-xs" value={resolved?.grain ?? ''} onChange={(e) => onChange({ grain: e.target.value as Grain, drill: undefined })} aria-label="Bucket size">
          {grains.map((g) => (
            <option key={g} value={g}>
              By {g}
            </option>
          ))}
        </select>
        <select className="input w-auto py-1 text-xs" value={search.compare} onChange={(e) => onChange({ compare: e.target.value as Compare })} aria-label="Comparison">
          {(Object.keys(COMPARE_LABELS) as Compare[]).map((c) => (
            <option key={c} value={c}>
              {COMPARE_LABELS[c]}
            </option>
          ))}
        </select>
        <div className="ml-auto flex items-center gap-2">{children}</div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <span className="mr-1 text-ink-muted">Model</span>
        {(meta?.dimensions.model ?? []).map((m) => (
          <button key={m} type="button" className={search.models.includes(m) ? 'chip-on' : 'chip text-ink-2 hover:bg-plane'} aria-pressed={search.models.includes(m)} onClick={() => onChange({ models: toggle(search.models, m), drill: undefined }, { replace: true })}>
            {m}
          </button>
        ))}
        <span className="ml-3 mr-1 text-ink-muted">Feature</span>
        {(meta?.dimensions.feature ?? []).map((f) => (
          <button key={f} type="button" className={search.features.includes(f) ? 'chip-on' : 'chip text-ink-2 hover:bg-plane'} aria-pressed={search.features.includes(f)} onClick={() => onChange({ features: toggle(search.features, f), drill: undefined }, { replace: true })}>
            {FEATURE_LABELS[f] ?? f}
          </button>
        ))}
        {activeChips.length > 0 && (
          <button type="button" className="ml-2 inline-flex items-center gap-1 text-ink-2 hover:text-ink" onClick={() => onChange({ models: [], features: [], drill: undefined })}>
            <CloseIcon className="h-3 w-3" /> Clear filters
          </button>
        )}
      </div>
    </div>
  )
}
