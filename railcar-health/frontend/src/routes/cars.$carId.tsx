import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { BearingPicker } from '@/components/cars/BearingPicker'
import { CarTrips } from '@/components/cars/CarTrips'
import { TrendChart, type TrendMode } from '@/components/cars/TrendChart'
import { HoldBadge } from '@/components/shared/Badges'
import { ErrorNote, Loading } from '@/components/shared/Loading'
import { PageHeader } from '@/components/shared/PageHeader'
import { TierBadge } from '@/components/shared/TierBadge'
import { positionText } from '@/lib/format'
import { useFetch } from '@/lib/hooks'
import { api } from '@/services/api'
import { useLiveStore } from '@/stores/live-store'

export const Route = createFileRoute('/cars/$carId')({
  validateSearch: (s: Record<string, unknown>): { position?: string } => ({ position: typeof s.position === 'string' ? s.position : undefined }),
  component: CarPage,
})

export function CarPage() {
  const { carId } = Route.useParams()
  const search = Route.useSearch()
  const navigate = useNavigate({ from: '/cars/$carId' })
  const revision = useLiveStore((s) => s.revisions.trips)
  const [mode, setMode] = useState<TrendMode>('median')
  const car = useFetch(() => api.car(carId), [carId, revision])
  const hottest = car.data?.bearings.slice().sort((a, b) => b.lastSideDelta - a.lastSideDelta)[0]?.position
  const position = search.position ?? car.data?.alerts.find((a) => a.kind === 'hot_bearing')?.position ?? hottest ?? 'R1'
  const trend = useFetch(() => api.trend(carId, position), [carId, position, revision])

  if (car.error) return <div className="page"><ErrorNote message={car.error} /></div>
  if (!car.data) return <Loading />
  const { car: info, holds, alerts, trips, bearings } = car.data
  const alerted = new Set(alerts.filter((a) => a.status !== 'closed' && a.kind === 'hot_bearing').map((a) => a.position))
  const activeHolds = holds.filter((h) => h.status !== 'released')
  return (
    <div className="page space-y-4">
      <PageHeader
        title={<span className="font-mono">{info.carId}</span>}
        subtitle={`${info.carType} · owned by ${info.ownerName} (${info.ownerMark}) · ${info.axleCount} axles`}
        actions={activeHolds.map((h) => <span key={h.id} className="flex items-center gap-1 text-sm"><HoldBadge status={h.status} /> at {h.yardName}</span>)}
      />
      <div className="grid grid-cols-3 gap-4">
        <section className="card col-span-2 p-4">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900">Bearing {position} across detectors and trips</h2>
            <div className="flex gap-1.5">
              <button type="button" className={mode === 'median' ? 'btn-primary' : 'btn-secondary'} onClick={() => setMode('median')}>vs train-side median</button>
              <button type="button" className={mode === 'ambient' ? 'btn-primary' : 'btn-secondary'} onClick={() => setMode('ambient')}>Above ambient</button>
            </div>
          </div>
          {trend.data ? <TrendChart series={trend.data.series} mode={mode} /> : <Loading />}
        </section>
        <div className="space-y-4">
          <section className="card p-4">
            <h2 className="mb-1 text-sm font-semibold text-slate-900">Bearings (latest trip)</h2>
            <BearingPicker bearings={bearings} selected={position} alerted={alerted} onSelect={(p) => void navigate({ search: { position: p } })} />
          </section>
          <section className="card p-4">
            <h2 className="mb-2 text-sm font-semibold text-slate-900">Alerts</h2>
            <ul className="space-y-2 text-sm">
              {alerts.slice(0, 6).map((a) => (
                <li key={a.id} className="flex items-center gap-2">
                  <TierBadge tier={a.tier} />
                  <Link to="/alerts" search={{ alert: a.id, status: 'all' }} className="text-accent-700 hover:underline">{positionText(a.kind, a.position)}</Link>
                  <span className="text-xs text-slate-500">{a.symbol} · {a.status === 'closed' ? a.outcome?.replace(/_/g, ' ') : a.status}</span>
                </li>
              ))}
              {alerts.length === 0 && <li className="text-slate-500">None.</li>}
            </ul>
          </section>
        </div>
      </div>
      <section className="card overflow-hidden">
        <h2 className="border-b border-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-900">Trips and orientation</h2>
        <CarTrips trips={trips} />
      </section>
    </div>
  )
}
