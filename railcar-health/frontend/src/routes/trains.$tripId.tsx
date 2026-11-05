import { createFileRoute, Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { ErrorNote, Loading } from '@/components/shared/Loading'
import { PageHeader } from '@/components/shared/PageHeader'
import { TierBadge } from '@/components/shared/TierBadge'
import { HeatLegend } from '@/components/trains/HeatLegend'
import { Heatmap } from '@/components/trains/Heatmap'
import { PassTable } from '@/components/trains/PassTable'
import { TrainSummary } from '@/components/trains/TrainSummary'
import { positionText } from '@/lib/format'
import type { HeatMode } from '@/lib/heat'
import { useFetch } from '@/lib/hooks'
import { api } from '@/services/api'
import { useClockStore } from '@/stores/clock-store'
import { useLiveStore } from '@/stores/live-store'

export const Route = createFileRoute('/trains/$tripId')({ component: TrainPage })

export function TrainPage() {
  const { tripId } = Route.useParams()
  const revision = useLiveStore((s) => s.revisions.trips)
  const [mode, setMode] = useState<HeatMode>('ambient')
  const detail = useFetch(() => api.trip(tripId), [tripId, revision])
  const heat = useFetch(() => api.heatmap(tripId), [tripId, revision])
  const alerts = useFetch(() => api.alerts({ status: 'all' }).then((r) => r.alerts.filter((a) => a.tripId === tripId)), [tripId, revision])
  const nowMs = useClockStore((s) => s.now)()
  useEffect(() => {
    if (detail.data) useClockStore.getState().update(detail.data.clock)
  }, [detail.data])

  if (detail.error) return <div className="page"><ErrorNote message={detail.error} /></div>
  if (!detail.data) return <Loading />
  const { trip, units, passes } = detail.data
  const corrected = units.filter((u) => u.orientationSource === 'aei')
  const toggle = (m: HeatMode, label: string) => (
    <button type="button" onClick={() => setMode(m)} className={mode === m ? 'btn-primary' : 'btn-secondary'}>{label}</button>
  )
  return (
    <div className="page space-y-4">
      <PageHeader title={<span className="font-mono">{trip.symbol} <span className="text-base text-slate-500">{trip.direction}</span></span>} subtitle={trip.tripId} />
      <TrainSummary trip={trip} nowMs={nowMs} />
      <section className="card p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">Bearing temperatures by detector</h2>
            <p className="text-xs text-slate-500">Rows: detectors in the order the train passed them (north and south rail). Columns: car axles from the head end.</p>
          </div>
          <div className="flex gap-1.5">{toggle('ambient', 'Above ambient')}{toggle('median', 'vs rail median')}</div>
        </div>
        {heat.data ? <Heatmap data={heat.data} mode={mode} /> : <Loading />}
        <div className="mt-3"><HeatLegend mode={mode} /></div>
      </section>
      <div className="grid grid-cols-3 gap-4">
        <section className="card col-span-2 overflow-hidden">
          <h2 className="border-b border-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-900">Detector passes</h2>
          <PassTable passes={passes} />
        </section>
        <div className="space-y-4">
          <section className="card p-4">
            <h2 className="mb-2 text-sm font-semibold text-slate-900">Alerts on this train</h2>
            <ul className="space-y-2">
              {(alerts.data ?? []).map((a) => (
                <li key={a.id} className="flex items-center gap-2 text-sm">
                  <TierBadge tier={a.tier} />
                  <Link to="/alerts" search={{ alert: a.id }} className="font-mono text-accent-700 hover:underline">{a.carId}</Link>
                  <span className="text-slate-500">{positionText(a.kind, a.position)}</span>
                  {a.status === 'closed' && <span className="text-xs text-slate-400">closed</span>}
                </li>
              ))}
              {alerts.data?.length === 0 && <li className="text-sm text-slate-500">None.</li>}
            </ul>
          </section>
          <section className="card p-4">
            <h2 className="mb-2 text-sm font-semibold text-slate-900">Orientation corrected by AEI</h2>
            <p className="mb-2 text-xs text-slate-500">The consist said otherwise; an AEI read showed which end leads, and earlier readings were re-mapped.</p>
            <ul className="space-y-1 text-sm">
              {corrected.map((u) => (
                <li key={u.position}>
                  <Link to="/cars/$carId" params={{ carId: u.unitId }} search={{ position: undefined }} className="font-mono text-accent-700 hover:underline">{u.unitId}</Link>
                  <span className="text-slate-500"> pos {u.position}: {u.leadingEnd}-end leading, by {u.correctedByDetector}</span>
                </li>
              ))}
              {corrected.length === 0 && <li className="text-sm text-slate-500">None: the consist matched every AEI read.</li>}
            </ul>
          </section>
        </div>
      </div>
    </div>
  )
}
