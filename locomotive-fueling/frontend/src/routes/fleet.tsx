import { createFileRoute } from '@tanstack/react-router'
import { AlertIcon, ClockIcon, FuelIcon, TrainIcon, TruckIcon } from '@/components/icons'
import { TrainRow } from '@/components/fleet/TrainRow'
import { ErrorNote, Loading } from '@/components/shared/Loading'
import { StatTile } from '@/components/shared/StatTile'
import { money, simTime } from '@/lib/format'
import { useRefresh } from '@/lib/use-refresh'
import { api } from '@/services/api'
import { useLiveStore } from '@/stores/live-store'

export const Route = createFileRoute('/fleet')({ component: Fleet })

function Fleet() {
  const ticks = useLiveStore((s) => s.ticks)
  const { data, error } = useRefresh(() => api.fleet(), { triggers: [ticks.train, ticks.plan, ticks.alert, ticks.order], coalesceMs: 2000 })
  if (!data) return error ? <ErrorNote message={error} /> : <Loading />
  const { summary } = data
  return (
    <div className="p-6">
      <div className="mb-4 flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Fleet fuel board</h1>
          <p className="text-sm text-slate-500">Smoothed fuel per unit, the next recommended stop, and whether the plan has been accepted.</p>
        </div>
        <div className="flex items-center gap-1.5 text-sm text-slate-500" title="Simulated time (the simulator compresses hours into minutes)">
          <ClockIcon className="h-4 w-4" /> Sim time <span className="num font-medium text-slate-700">{simTime(data.simNow)}</span>
        </div>
      </div>
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatTile label="Trains running" value={summary.running} icon={<TrainIcon className="h-5 w-5" />} />
        <StatTile label="Open alerts" value={summary.openAlerts} icon={<AlertIcon className="h-5 w-5" />} />
        <StatTile label="Active DTL orders" value={summary.activeOrders} icon={<TruckIcon className="h-5 w-5" />} />
        <StatTile label="Fuel to buy" value={money(summary.plannedFuelCost)} hint="Purchases and truck fees in the plans in force" icon={<FuelIcon className="h-5 w-5" />} />
        <StatTile label="Lowest unit" value={`${Math.round(summary.lowestFuelPct)}%`} hint="Fuel level, any running unit" icon={<FuelIcon className="h-5 w-5" />} />
      </div>
      <div className="card overflow-hidden">
        <table className="w-full" aria-label="Trains">
          <thead className="bg-slate-50">
            <tr>
              <th className="th">Train</th>
              <th className="th">Position</th>
              <th className="th">Fuel by unit (tick = reserve)</th>
              <th className="th">Next fuel stop</th>
              <th className="th">Plan</th>
              <th className="th">Alerts</th>
            </tr>
          </thead>
          <tbody>
            {data.trains.map((t) => (
              <TrainRow key={t.id} train={t} nowMs={data.simNow} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
