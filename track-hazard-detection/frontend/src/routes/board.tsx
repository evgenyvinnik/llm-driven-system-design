import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { HazardList } from '@/components/board/HazardList'
import { KpiRow } from '@/components/board/KpiRow'
import { Legend } from '@/components/board/Legend'
import { StripMap } from '@/components/board/StripMap'
import { ErrorNote, Loading } from '@/components/shared/Loading'
import { PageHeader } from '@/components/shared/PageHeader'
import { ageText } from '@/lib/format'
import { useFetch, useTicker } from '@/lib/hooks'
import { api } from '@/services/api'
import { useLiveStore } from '@/stores/live-store'

export const Route = createFileRoute('/board')({ component: BoardPage })

export function BoardPage() {
  const rev = useLiveStore((s) => s.revisions)
  const navigate = useNavigate()
  const now = useTicker(5000)
  const { data, error } = useFetch(() => api.board(), [rev.hazards, rev.trains, rev.coverage, rev.restrictions, rev.alerts])
  if (error && !data) return <div className="page"><ErrorNote message={error} /></div>
  if (!data) return <Loading />
  const select = (hazardId: string) => void navigate({ to: '/hazards/$hazardId', params: { hazardId } })
  const gaps = data.coverage
  return (
    <div className="page space-y-4">
      <PageHeader title="Operator board" subtitle="Hazards, coverage, slow orders and trains on the Canyon and Prairie subdivisions, updated live" actions={<Legend />} />
      <KpiRow board={data} />
      {data.subdivisions.map((sub) => (
        <section key={sub.id} className="card px-4 pb-2 pt-3" aria-label={sub.name}>
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold text-slate-800">
              {sub.name} <span className="font-normal text-slate-400">MP {sub.startMp}–{sub.endMp} · {sub.deskId} desk</span>
            </h2>
            <span className="text-xs text-slate-400">{data.trains.filter((t) => t.subdivisionId === sub.id).length} trains</span>
          </div>
          <StripMap subdivision={sub} board={data} onSelect={select} />
        </section>
      ))}
      <div className="grid gap-4 lg:grid-cols-3">
        <section className="card lg:col-span-2">
          <div className="border-b border-slate-100 px-4 py-2.5 panel-title">Hazards (open, and closed in the last 10 min)</div>
          <HazardList hazards={data.hazards} now={now} />
        </section>
        <section className="card">
          <div className="border-b border-slate-100 px-4 py-2.5 panel-title">Coverage gaps</div>
          {gaps.length === 0 ? (
            <p className="px-4 py-6 text-sm text-slate-500">Every sensor and gateway is reporting.</p>
          ) : (
            <ul className="divide-y divide-slate-100 text-sm" aria-label="Coverage gaps">
              {gaps.map((c) => (
                <li key={c.key} className="px-4 py-2.5">
                  <div className="font-medium text-red-700">{c.scope === 'gateway' ? `${c.targetId} silent` : `${c.targetId} missed heartbeats`}</div>
                  <div className="text-xs text-slate-500">
                    {c.segmentId} · MP {c.mpFrom}–{c.mpTo} · blind since {ageText(c.since, now)}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}
