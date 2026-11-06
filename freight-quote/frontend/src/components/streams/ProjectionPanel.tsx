import { useState } from 'react'
import { ago } from '@/lib/format'
import { api } from '@/services/api'
import type { ReplayResult, StreamsOverview } from '@/types'

export function ProjectionPanel({ projection, canRebuild }: { projection: StreamsOverview['projection']; canRebuild: boolean }) {
  const [result, setResult] = useState<ReplayResult | null>(null)
  const [busy, setBusy] = useState(false)
  const run = async (fn: () => Promise<ReplayResult>) => {
    setBusy(true)
    try {
      setResult(await fn())
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="card p-4" aria-label="Analytics projection">
      <div className="panel-title mb-2">Projection: analytics</div>
      {projection ? (
        <dl className="grid grid-cols-2 gap-y-1 text-sm">
          <dt className="text-slate-500">Events applied</dt>
          <dd className="text-right tabular-nums">{projection.eventsApplied}</dd>
          <dt className="text-slate-500">Staleness</dt>
          <dd className={`text-right tabular-nums ${projection.stalenessSeconds > 5 ? 'text-amber-700' : ''}`}>{projection.stalenessSeconds} s</dd>
          <dt className="text-slate-500">Last rebuilt</dt>
          <dd className="text-right text-xs">{projection.rebuiltAt ? ago(projection.rebuiltAt) : 'never (live only)'}</dd>
        </dl>
      ) : (
        <p className="text-sm text-slate-500">Not built yet.</p>
      )}
      <div className="mt-3 flex gap-2">
        <button type="button" className="btn-secondary flex-1 text-xs" disabled={busy} onClick={() => void run(api.verifyProjection)}>
          Verify replay = live
        </button>
        <button type="button" className="btn-secondary flex-1 text-xs" disabled={busy || !canRebuild} onClick={() => void run(api.rebuildProjection)} title={canRebuild ? 'Rebuild from position 0' : 'Admin only'}>
          Rebuild from 0
        </button>
      </div>
      {result && (
        <div className={`mt-3 rounded-md px-3 py-2 text-xs ${result.match ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-800'}`}>
          {result.match ? 'Match' : 'MISMATCH'}: folded {result.events} events from position 0 ({result.upcast} upcast from v1) in {result.ms} ms
          {result.notYetApplied > 0 ? `; ${result.notYetApplied} not yet applied live (lag)` : ''}.
          {result.diffs.slice(0, 3).map((d) => (
            <div key={d} className="font-mono">{d}</div>
          ))}
        </div>
      )}
    </section>
  )
}
