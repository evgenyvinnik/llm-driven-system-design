import type { UseQueryResult } from '@tanstack/react-query'
import type { MetricInfo, SeriesBucket, SeriesResponse } from '../../lib/api'
import { localTime } from '../../lib/format'
import { TrendChart } from '../charts/TrendChart'
import { WidgetFrame } from './WidgetFrame'

interface Props {
  query: UseQueryResult<SeriesResponse>
  metrics: MetricInfo[]
  metric: string
  onMetric: (id: string) => void
  compareLabel: string | null
  drill?: string
  onDrill?: (bucket: SeriesBucket) => void
}

export function TrendWidget({ query, metrics, metric, onMetric, compareLabel, drill, onDrill }: Props) {
  const info = metrics.find((m) => m.id === metric)
  return (
    <WidgetFrame
      title={info?.label ?? metric}
      testId="trend"
      subtitle={info ? <span title={info.definition}>{firstSentence(info.definition)}</span> : undefined}
      query={query}
      minHeight={290}
      isEmpty={(d) => d.buckets.every((b) => !b.value && b.coverage === 'ok' && !b.suppressed)}
      actions={
        <select className="input w-auto py-1 text-xs" value={metric} onChange={(e) => onMetric(e.target.value)} aria-label="Metric">
          {metrics.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      }
      notes={(d) => (
        <>
          {d.coverage && (
            <p>
              <strong className="font-medium text-ink">Coverage:</strong> {d.coverage.note} Collected from {localTime(d.coverage.collectedFrom, 'UTC', 'MMM d')} UTC
              {d.coverage.availableFrom !== d.coverage.collectedFrom && <>, rollups available from {localTime(d.coverage.availableFrom, 'UTC', 'MMM d')} UTC</>}. Buckets that start earlier are shown as a gap, not as zero.
            </p>
          )}
          {d.buckets.some((b) => b.lateEvents > 0) && <p>↻ marks buckets that late events changed after they were first shown.</p>}
          {onDrill && <p>Click a bar to list the conversations behind it.</p>}
        </>
      )}
    >
      {(d) => (
        <TrendChart
          buckets={d.buckets}
          metric={d.metric}
          grain={d.grain}
          timeZone={d.timeZone}
          watermark={d.watermark}
          compareLabel={compareLabel}
          selected={drill}
          onSelect={onDrill}
        />
      )}
    </WidgetFrame>
  )
}

function firstSentence(text: string): string {
  const s = text.split('. ')[0]
  return s.endsWith('.') ? s : `${s}.`
}
