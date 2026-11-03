import { useState } from 'react'
import type { UseQueryResult } from '@tanstack/react-query'
import type { LatencyResponse } from '../../lib/api'
import type { Grain } from '../../lib/filters'
import { LatencyChart } from '../charts/LatencyChart'
import { WidgetFrame } from './WidgetFrame'

export function LatencyWidget({ query, grain, timeZone }: { query: UseQueryResult<LatencyResponse>; grain: Grain; timeZone: string }) {
  const [field, setField] = useState<'ttft' | 'latency'>('ttft')
  return (
    <WidgetFrame
      title={field === 'ttft' ? 'Time to first token' : 'Total response time'}
      subtitle="Percentiles over completed responses, merged from t-digest sketches"
      query={query}
      testId="latency"
      isEmpty={(d) => d.buckets.every((b) => b.responses === 0 && !b.suppressed)}
      notes={(d) => {
        const hidden = d.buckets.filter((b) => b.suppressed).length
        return hidden > 0 && <p>{hidden} bucket{hidden === 1 ? '' : 's'} hidden: fewer than 5 users.</p>
      }}
      actions={
        <div className="flex rounded-md border text-xs" style={{ borderColor: 'var(--border)' }} role="group" aria-label="Latency measure">
          {(['ttft', 'latency'] as const).map((f) => (
            <button key={f} type="button" onClick={() => setField(f)} aria-pressed={field === f} className={`px-2 py-1 ${field === f ? 'bg-plane font-medium text-ink' : 'text-ink-2'}`}>
              {f === 'ttft' ? 'TTFT' : 'Total'}
            </button>
          ))}
        </div>
      }
    >
      {(d) => <LatencyChart data={d} field={field} grain={grain} timeZone={timeZone} />}
    </WidgetFrame>
  )
}
