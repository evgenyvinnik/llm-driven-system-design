import { createFileRoute } from '@tanstack/react-router'
import { TimeQualityChart } from '@/components/compare/TimeQualityChart'
import { Chip } from '@/components/shared/Chips'
import { ErrorNote, Loading } from '@/components/shared/Loading'
import { StatTile } from '@/components/shared/StatTile'
import { usePolling } from '@/lib/usePolling'
import { api } from '@/services/api'
import type { ComparisonRow } from '@/types'

export const Route = createFileRoute('/compare')({ component: ComparePage })

function ComparePage() {
  const { data, error, refresh } = usePolling(api.comparison, 3000)
  if (error && !data) return <main className="page"><ErrorNote message={error} /></main>
  if (!data) return <Loading />
  const rows = data.rows
  const small = [...new Set(rows.filter((r) => r.kind === 'small').map((r) => r.instance))]
  const row = (instance: string, algorithm: ComparisonRow['algorithm']) => rows.find((r) => r.instance === instance && r.algorithm === algorithm)
  const full = rows.filter((r) => r.kind === 'full')
  const lsFull = full.filter((r) => r.algorithm === 'local_search').sort((a, b) => a.elapsedMs - b.elapsedMs)
  const greedyFull = full.find((r) => r.algorithm === 'greedy')
  const exactFull = full.find((r) => r.algorithm === 'exact')
  const s = data.run?.summary
  return (
    <main className="page">
      <header className="flex items-center gap-3">
        <h1 className="text-lg font-semibold text-slate-900">Heuristic, local search and exact search</h1>
        <div className="flex-1" />
        <button type="button" className="btn-secondary" disabled={Boolean(data.active)} onClick={() => void api.runComparison().then(refresh)}>
          {data.active ? 'Running…' : 'Run again'}
        </button>
      </header>
      <p className="text-sm text-slate-600">
        All three build plans through the same decoder and are costed the same way, so the gap is comparable. &quot;Exact&quot; means proven best over that decoder&apos;s decisions (which train per group, which track per cut, in what order). It doesn&apos;t cover every conceivable schedule, and on a full shift it times out.
      </p>
      {!data.run && <p className="card p-4 text-sm text-slate-500">No comparison yet. Run one.</p>}
      {s && (
        <section className="grid grid-cols-2 gap-2 md:grid-cols-4" aria-label="Summary">
          <StatTile label="Small instances proven" value={`${s.provenOptimal} / ${s.smallInstances}`} />
          <StatTile label="Greedy gap" value={s.greedyAvgGapPct === null ? '–' : `${s.greedyAvgGapPct}%`} hint={`worst ${s.greedyMaxGapPct ?? '–'}%`} />
          <StatTile label="Local search gap" value={s.localSearchAvgGapPct === null ? '–' : `${s.localSearchAvgGapPct}%`} hint={`worst ${s.localSearchMaxGapPct ?? '–'}%`} />
          <StatTile label="Full-shift exact" value={exactFull ? exactFull.terminatedBy.replace('_', ' ') : '–'} hint={exactFull ? `best so far ${exactFull.cost.toFixed(0)}` : undefined} />
        </section>
      )}
      <div className="grid gap-4 xl:grid-cols-2">
        <TimeQualityChart rows={lsFull} greedyCost={greedyFull?.cost ?? null} />
        <div className="card overflow-x-auto">
          <table className="w-full" aria-label="Small instances">
            <thead>
              <tr>
                <th className="th">Instance</th>
                <th className="th text-right">Greedy</th>
                <th className="th text-right">Local search</th>
                <th className="th text-right">Exact</th>
                <th className="th text-right">Exact time</th>
                <th className="th">Proof</th>
              </tr>
            </thead>
            <tbody>
              {small.map((name) => {
                const g = row(name, 'greedy')
                const l = row(name, 'local_search')
                const e = row(name, 'exact')
                const cell = (r?: ComparisonRow) => (r ? `${r.cost.toFixed(1)}${r.gapPct ? ` (+${r.gapPct}%)` : ''}` : '–')
                return (
                  <tr key={name} className="border-t border-slate-100">
                    <td className="td font-mono text-xs">{name}</td>
                    <td className="td num text-right">{cell(g)}</td>
                    <td className="td num text-right">{cell(l)}</td>
                    <td className="td num text-right">{e?.cost.toFixed(1) ?? '–'}</td>
                    <td className="td num text-right">{e ? `${e.elapsedMs} ms` : '–'}</td>
                    <td className="td">{e?.provenOptimal ? <Chip kind="good">proven</Chip> : <Chip kind="warn">timed out</Chip>}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
      <div className="card overflow-x-auto">
        <table className="w-full" aria-label="Full shift solves">
          <thead>
            <tr>
              <th className="th">Algorithm</th>
              <th className="th text-right">Budget</th>
              <th className="th text-right">Took</th>
              <th className="th text-right">Iterations</th>
              <th className="th text-right">Cost</th>
              <th className="th">Ended by</th>
              <th className="th">Validator</th>
            </tr>
          </thead>
          <tbody>
            {full.map((r) => (
              <tr key={`${r.algorithm}-${r.timeLimitMs}`} className="border-t border-slate-100">
                <td className="td font-mono text-xs">{r.algorithm}</td>
                <td className="td num text-right">{r.timeLimitMs.toLocaleString()} ms</td>
                <td className="td num text-right">{r.elapsedMs.toLocaleString()} ms</td>
                <td className="td num text-right">{r.iterations.toLocaleString()}</td>
                <td className="td num text-right">{r.cost.toFixed(1)}</td>
                <td className="td">{r.terminatedBy.replace('_', ' ')}</td>
                <td className="td">{r.valid ? <Chip kind="good">passes</Chip> : <Chip kind="bad">fails</Chip>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  )
}
