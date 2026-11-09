import { Link, createFileRoute } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { AlertIcon } from '@/components/icons'
import { DiffTable } from '@/components/plans/DiffTable'
import { VersionChip } from '@/components/shared/Chips'
import { ErrorNote, Loading } from '@/components/shared/Loading'
import { StatTile } from '@/components/shared/StatTile'
import { usePolling } from '@/lib/usePolling'
import { api } from '@/services/api'

export const Route = createFileRoute('/plans/$id')({ component: PlanPage })

function PlanPage() {
  const { id } = Route.useParams()
  const { data, error } = usePolling(() => api.diff(id), 0)
  const [showKept, setShowKept] = useState(false)
  const changes = useMemo(() => {
    const list = data?.changes ?? []
    const order = { changed: 0, added: 1, removed: 2, reordered: 3, kept: 4 }
    return [...list].filter((c) => showKept || c.type !== 'kept').sort((a, b) => order[a.type] - order[b.type])
  }, [data, showKept])
  if (error && !data) return <main className="page"><ErrorNote message={error} /></main>
  if (!data) return <Loading />
  const { to, from, counts } = data
  const s = to.stability
  const untouched = data.changes.filter((c) => c.type === 'kept').length
  const consequences = to.consequences.filter((c) => c.kind !== 'cars_unassigned')
  const unassigned = to.consequences.filter((c) => c.kind === 'cars_unassigned')
  return (
    <main className="page" data-testid="plan-diff">
      <header className="flex flex-wrap items-center gap-2">
        <Link className="text-sm text-accent-700 hover:underline" to="/plans">Plans</Link>
        <h1 className="text-lg font-semibold text-slate-900">Plan v{to.versionNo}</h1>
        <VersionChip status={to.status} />
        <span className="text-sm text-slate-600">by {to.authorName}, built on yard state v{to.basedOnStateVersion}{from ? `, parent v${from.versionNo}` : ''}</span>
      </header>
      <p className="text-sm text-slate-700">Why this version exists: {to.reason}</p>
      {counts && (
        <section className="grid grid-cols-2 gap-2 md:grid-cols-6" aria-label="Diff summary">
          <StatTile label="Left alone" value={untouched} hint="same cars, tracks, order" />
          <StatTile label="Changed" value={counts.changed} hint="cars or tracks differ" />
          <StatTile label="Reordered" value={counts.reordered} />
          <StatTile label="Added" value={counts.added} />
          <StatTile label="Removed" value={counts.removed} />
          <StatTile label="Only retimed" value={counts.retimed} hint="same move, new time" />
        </section>
      )}
      {s && (
        <section className="card p-3 text-sm text-slate-700" aria-label="Stability" data-testid="stability">
          <h2 className="panel-title mb-1">Stability</h2>
          This replan disturbed <strong className="num">{s.stable.disturbed}</strong> moves. Solving from scratch, ignoring the old plan, would have disturbed <strong className="num">{s.fromScratch.disturbed}</strong>.
          {' '}<strong className="num">{s.frozenMoves}</strong> moves already done or in progress were frozen, and <strong className="num">{s.horizonMoves}</strong> more inside the {s.frozenHorizonMin}-minute frozen horizon were kept.
        </section>
      )}
      {consequences.length > 0 && (
        <section className="card p-3" aria-label="Consequences" data-testid="consequences">
          <h2 className="panel-title mb-1">What this costs</h2>
          <ul className="space-y-1 text-sm">
            {consequences.map((c, i) => (
              <li key={i} className={`flex items-start gap-1.5 ${c.kind === 'departure_missed' ? 'font-medium text-rose-900' : 'text-slate-700'}`}>
                {c.kind === 'departure_missed' && <AlertIcon className="mt-0.5 h-4 w-4 shrink-0" />} {c.message}
              </li>
            ))}
            {unassigned.map((c, i) => (
              <li key={`u${i}`} className="text-slate-600">{c.message}</li>
            ))}
          </ul>
        </section>
      )}
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-slate-900">Moves</h2>
        <label className="flex items-center gap-1.5 text-xs text-slate-600">
          <input type="checkbox" checked={showKept} onChange={(e) => setShowKept(e.target.checked)} /> Show moves left alone
        </label>
      </div>
      <DiffTable changes={changes} />
    </main>
  )
}
