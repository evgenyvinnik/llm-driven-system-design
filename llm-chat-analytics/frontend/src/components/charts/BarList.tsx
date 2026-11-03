/**
 * Horizontal bars for a breakdown. Clicking a row toggles it as a filter for
 * every other widget (cross-filtering); this chart keeps showing all rows and
 * highlights the selected ones. Suppressed rows show why they have no number.
 */
import type { BreakdownRow, Unit } from '../../lib/api'
import { formatValue } from '../../lib/format'
import { EyeOffIcon } from '../icons'

interface Props {
  rows: BreakdownRow[]
  unit: Unit
  approximate: boolean
  selected: string[]
  label?: (key: string) => string
  shareLabel?: string
  minCohortUsers: number
  onToggle?: (key: string) => void
}

export function BarList({ rows, unit, approximate, selected, label = (k) => k, shareLabel, minCohortUsers, onToggle }: Props) {
  const max = Math.max(...rows.map((r) => r.value ?? 0), 0) || 1
  return (
    <ul className="space-y-1.5" role="list">
      {rows.map((r) => {
        const isSelected = selected.includes(r.key)
        const dim = selected.length > 0 && !isSelected
        if (r.suppressed) {
          return (
            <li key={r.key} className="flex items-center gap-2 rounded px-2 py-1.5 text-xs text-ink-2">
              <EyeOffIcon className="h-3.5 w-3.5 shrink-0" />
              <span className="font-medium">{r.key}</span>
              <span className="text-ink-muted">hidden: fewer than {minCohortUsers} users{r.users > 0 ? '' : ' even when pooled'}</span>
            </li>
          )
        }
        const pct = ((r.value ?? 0) / max) * 100
        return (
          <li key={r.key}>
            <button
              type="button"
              onClick={() => onToggle?.(r.key)}
              aria-pressed={isSelected}
              className={`group w-full rounded px-2 py-1.5 text-left transition-colors hover:bg-plane ${isSelected ? 'bg-plane' : ''}`}
              title={onToggle ? (isSelected ? 'Remove this filter' : 'Filter the dashboard to this') : undefined}
            >
              <div className="mb-1 flex items-baseline justify-between gap-2 text-xs">
                <span className={`truncate font-medium ${dim ? 'text-ink-muted' : 'text-ink'}`}>
                  {isSelected && <span aria-hidden>✓ </span>}
                  {label(r.key)}
                </span>
                <span className="tabular shrink-0 text-ink-2">
                  {approximate ? '≈ ' : ''}
                  {formatValue(r.value, unit, { compact: true })}
                  {shareLabel && r.share !== null && <span className="ml-1.5 text-ink-muted">{Math.round(r.share * 100)}% {shareLabel}</span>}
                </span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-sm bg-plane">
                <div className="h-2 rounded-r-[4px]" style={{ width: `${Math.max(pct, 0.5)}%`, background: 'var(--series-1)', opacity: dim ? 0.3 : 1 }} />
              </div>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
