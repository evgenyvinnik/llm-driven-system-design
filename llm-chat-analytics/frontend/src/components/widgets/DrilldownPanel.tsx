/**
 * The conversations behind one bar. The request carries the chart's own
 * resolved query plus the bucket, and the server runs the chart's predicate
 * against raw events, so the panel can show that the rows add up to the bar.
 * Metadata only: there is no content anywhere in the pipeline to show.
 */
import { useState } from 'react'
import { ApiError, type DrilldownResponse } from '../../lib/api'
import type { ResolvedQuery } from '../../lib/filters'
import { bucketLabel, FEATURE_LABELS, formatValue, localTime } from '../../lib/format'
import { useDrilldown } from '../../lib/queries'
import { CheckIcon, CloseIcon, EyeOffIcon, LockIcon, SpinnerIcon } from '../icons'

interface Props {
  query: ResolvedQuery
  metric: string
  bucket: string
  timeZone: string
  onClose: () => void
}

export function DrilldownPanel({ query, metric, bucket, timeZone, onClose }: Props) {
  const [pages, setPages] = useState(1)
  const first = useDrilldown(query, metric, bucket, 0)
  const data = first.data
  return (
    <section className="card p-4" aria-label="Drill-down" data-testid="drilldown">
      <header className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="widget-title">
            {data?.metric.label ?? 'Drill-down'} · {bucketLabel(bucket, query.grain, timeZone)}
          </h2>
          <p className="mt-0.5 text-xs text-ink-2">
            Same query as the chart: {query.models.length ? query.models.join(', ') : 'all models'} · {query.features.length ? query.features.map((f) => FEATURE_LABELS[f] ?? f).join(', ') : 'all features'} · one{' '}
            {query.grain} bucket
          </p>
        </div>
        <button type="button" className="btn-ghost px-2" onClick={onClose} aria-label="Close drill-down">
          <CloseIcon />
        </button>
      </header>

      {first.isPending && (
        <p className="flex items-center gap-2 text-sm text-ink-2">
          <SpinnerIcon /> Running the chart’s query against raw events…
        </p>
      )}
      {first.error instanceof ApiError && first.error.status === 403 && (
        <p className="flex items-center gap-2 text-sm text-ink-2">
          <LockIcon /> {first.error.message}
        </p>
      )}
      {first.error && !(first.error instanceof ApiError && first.error.status === 403) && <p className="text-sm text-status-critical">{(first.error as Error).message}</p>}

      {data && (
        <>
          <Reconciliation data={data} />
          {data.suppressed ? (
            <p className="mt-3 flex items-center gap-2 text-sm text-ink-2">
              <EyeOffIcon /> Fewer than {data.minCohortUsers} users are behind this bar, so individual conversations are hidden.
            </p>
          ) : (
            <div className="mt-3 overflow-x-auto">
              <p className="mb-1 text-xs text-ink-muted">Each row is a conversation with events behind the bar; messages, tokens{data.columns.includes('costUsd') ? ', cost' : ''} and TTFT are that conversation’s own totals.</p>
              <table className="w-full min-w-[720px] text-left text-xs">
                <thead className="text-ink-muted">
                  <tr>
                    <th className="py-1.5 pr-3 font-medium">Conversation</th>
                    <th className="py-1.5 pr-3 font-medium">User (pseudonymous)</th>
                    <th className="py-1.5 pr-3 font-medium">First event</th>
                    <th className="py-1.5 pr-3 font-medium">Model</th>
                    <th className="py-1.5 pr-3 font-medium">Features</th>
                    <th className="py-1.5 pr-3 text-right font-medium" title="Events of this conversation behind the bar">In bar</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Messages</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Tokens</th>
                    {data.columns.includes('costUsd') && <th className="py-1.5 pr-3 text-right font-medium">Cost</th>}
                    <th className="py-1.5 pr-3 text-right font-medium">Max TTFT</th>
                    <th className="py-1.5 font-medium">Notes</th>
                  </tr>
                </thead>
                <tbody className="tabular">
                  {Array.from({ length: pages }, (_, p) => (
                    <DrillPage key={p} query={query} metric={metric} bucket={bucket} offset={p * 25} first={p === 0 ? data : undefined} timeZone={timeZone} />
                  ))}
                </tbody>
              </table>
              {pages * 25 < data.conversations && (
                <button type="button" className="btn-secondary mt-3" onClick={() => setPages((n) => n + 1)}>
                  Load 25 more ({(data.conversations - pages * 25).toLocaleString()} left)
                </button>
              )}
            </div>
          )}
        </>
      )}
    </section>
  )
}

function Reconciliation({ data }: { data: DrilldownResponse }) {
  const listed = data.counts === 'users' ? data.users : data.matched
  const what = data.counts === 'users' ? 'users' : data.metric.drill.eventTypes.length > 1 ? 'responses' : 'events'
  const exact = !data.metric.approximate || data.counts === 'events'
  const matches = listed === data.rollupCount
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md bg-plane px-3 py-2 text-xs" data-testid="drill-reconciliation">
      <span>
        Bar: <strong className="tabular">{exact ? '' : '≈ '}{data.rollupCount.toLocaleString()}</strong> {what}
        {data.barValue !== null && data.metric.unit !== 'count' && <> ({formatValue(data.barValue, data.metric.unit)})</>}
      </span>
      <span>
        Raw events: <strong className="tabular">{listed.toLocaleString()}</strong> {what} in {data.conversations.toLocaleString()} conversations from {data.users.toLocaleString()} users
      </span>
      {exact ? (
        matches ? (
          <span className="flex items-center gap-1 font-medium" style={{ color: 'var(--delta-good)' }}>
            <CheckIcon className="h-3.5 w-3.5" /> rows add up to the bar
          </span>
        ) : (
          <span className="font-medium" style={{ color: 'var(--delta-bad)' }}>
            Mismatch of {Math.abs(listed - data.rollupCount)}: the rollup and raw events disagree (a duplicate past dedup?)
          </span>
        )
      ) : (
        <span className="text-ink-2">The bar is a HyperLogLog estimate; the list is exact.</span>
      )}
    </div>
  )
}

function DrillPage({ query, metric, bucket, offset, first, timeZone }: { query: ResolvedQuery; metric: string; bucket: string; offset: number; first?: DrilldownResponse; timeZone: string }) {
  const page = useDrilldown(query, metric, bucket, offset)
  const data = first ?? page.data
  if (!data) {
    return (
      <tr>
        <td colSpan={11} className="py-2 text-ink-2">
          <SpinnerIcon className="mr-1 inline h-3 w-3" /> Loading…
        </td>
      </tr>
    )
  }
  return (
    <>
      {data.rows.map((r) => (
        <tr key={r.conversation} className="border-t" style={{ borderColor: 'var(--gridline)' }}>
          <td className="py-1.5 pr-3 font-mono text-[11px]">{r.conversation}</td>
          <td className="py-1.5 pr-3 font-mono text-[11px] text-ink-2">{r.user}</td>
          <td className="py-1.5 pr-3">{localTime(r.firstEventAt, timeZone, 'MMM d HH:mm:ss')}</td>
          <td className="py-1.5 pr-3">{r.model}</td>
          <td className="py-1.5 pr-3">{r.features.map((f) => FEATURE_LABELS[f] ?? f).join(', ')}</td>
          <td className="py-1.5 pr-3 text-right">{r.matchedEvents}</td>
          <td className="py-1.5 pr-3 text-right">{r.messages}</td>
          <td className="py-1.5 pr-3 text-right">{r.tokens.toLocaleString()}</td>
          {data.columns.includes('costUsd') && <td className="py-1.5 pr-3 text-right">{formatValue(r.costUsd ?? 0, 'usd')}</td>}
          <td className="py-1.5 pr-3 text-right">{r.maxTtftMs ? formatValue(r.maxTtftMs, 'ms') : '—'}</td>
          <td className="py-1.5 text-ink-2">{[...r.errors, r.late ? 'arrived late' : ''].filter(Boolean).join(', ')}</td>
        </tr>
      ))}
    </>
  )
}
