import type { UseQueryResult } from '@tanstack/react-query'
import type { BreakdownResponse } from '../../lib/api'
import { FEATURE_LABELS } from '../../lib/format'
import { BarList } from '../charts/BarList'
import { WidgetFrame } from './WidgetFrame'

interface Props {
  title: string
  query: UseQueryResult<BreakdownResponse>
  selected: string[]
  onToggle: (key: string) => void
  shareLabel?: string
}

export function BreakdownWidget({ title, query, selected, onToggle, shareLabel }: Props) {
  return (
    <WidgetFrame
      title={title}
      query={query}
      testId={`breakdown-${query.data?.dimension ?? 'loading'}`}
      minHeight={180}
      subtitle={query.data && <>{query.data.metric.label} · click a row to filter everything else</>}
      isEmpty={(d) => d.rows.length === 0}
      actions={query.data?.partial && <span className="badge bg-plane text-ink-2">Partial</span>}
      notes={(d) =>
        d.hiddenGroups > 0 && (
          <p>
            {d.hiddenGroups} group{d.hiddenGroups === 1 ? '' : 's'} under {d.minCohortUsers} users {d.otherSuppressed ? 'hidden' : 'pooled into “other”'} to protect individuals.
          </p>
        )
      }
    >
      {(d) => (
        <BarList
          rows={d.rows}
          unit={d.metric.unit}
          approximate={d.metric.approximate}
          selected={selected}
          onToggle={onToggle}
          minCohortUsers={d.minCohortUsers}
          shareLabel={shareLabel}
          label={d.dimension === 'feature' ? (k) => FEATURE_LABELS[k] ?? k : undefined}
        />
      )}
    </WidgetFrame>
  )
}
