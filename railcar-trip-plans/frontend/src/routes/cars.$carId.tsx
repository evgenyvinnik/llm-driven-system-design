import { createFileRoute, Link } from '@tanstack/react-router'
import { CarExceptions, CarSagas } from '@/components/cars/CarSide'
import { EtaHistoryChart } from '@/components/cars/EtaHistoryChart'
import { EtaPanel } from '@/components/cars/EtaPanel'
import { PlanVersions } from '@/components/cars/PlanVersions'
import { PlanBadge, PositionBadge, StatusBadge } from '@/components/shared/Badges'
import { ErrorNote, Loading } from '@/components/shared/Loading'
import { CarTimeline } from '@/components/timeline/CarTimeline'
import { fmtTime, relative, useNow } from '@/lib/format'
import { usePoll } from '@/lib/hooks'
import { api } from '@/services/api'
import { useAuthStore } from '@/stores/auth-store'

type Tab = 'plan' | 'timeline'

export const Route = createFileRoute('/cars/$carId')({
  validateSearch: (search: Record<string, unknown>): { tab: Tab } => ({ tab: search.tab === 'timeline' ? 'timeline' : 'plan' }),
  component: CarPage,
})

export function CarPage() {
  const { carId } = Route.useParams()
  const { tab } = Route.useSearch()
  const now = useNow()
  const role = useAuthStore((s) => s.user!.role)
  const { data, error } = usePoll(() => api.car(carId), [carId])
  if (error) return <div className="page"><ErrorNote message={error} /></div>
  if (!data) return <Loading />
  const { car, plan, versions } = data
  const original = data.originalDelivery
  return (
    <div className="page">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link to="/cars" className="text-xs text-accent-700 hover:underline">← Cars</Link>
          <h1 className="font-mono text-xl font-semibold text-slate-900">{car.car_id}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-600">
            <StatusBadge status={car.status} />
            <PositionBadge confidence={car.position_confidence} />
            <PlanBadge status={car.plan_status} version={car.plan_version} />
            <span>
              {car.car_type} · {car.shipper_name} · {plan ? `${plan.origin_yard} → ${plan.destination_yard}${plan.handoff_road ? ` → ${plan.handoff_road}` : ''} (${plan.destination_customer})` : 'no plan'}
            </span>
          </div>
          <div className="mt-1 text-xs text-slate-500">
            {car.status === 'in_transit' ? `On ${car.train_run_id}` : `At ${car.location_id ?? '—'}`} · last car-level read {relative(car.last_observed_at, now)} ({fmtTime(car.last_observed_at)}) · source {car.position_source ?? '—'} · {car.missed_reads} missed reads · {car.late_events} late events
          </div>
        </div>
        <div className="flex gap-1" role="tablist">
          <Link to="/cars/$carId" params={{ carId }} search={{ tab: 'plan' }} className={tab === 'plan' ? 'tab-active' : 'tab'}>Plan & ETA</Link>
          <Link to="/cars/$carId" params={{ carId }} search={{ tab: 'timeline' }} className={tab === 'timeline' ? 'tab-active' : 'tab'}>Event timeline</Link>
        </div>
      </div>
      {tab === 'timeline' ? (
        <CarTimeline carId={carId} />
      ) : (
        <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
          <div className="space-y-4">
            <EtaPanel eta={data.eta} now={now} originalArrival={original} />
            <div className="card p-4">
              <div className="panel-title mb-2">How the ETA evolved</div>
              <EtaHistoryChart history={data.etaHistory} />
            </div>
            <div className="card p-4">
              <div className="panel-title mb-2">Trip plan versions</div>
              <PlanVersions versions={versions} current={plan?.current_version ?? 1} />
            </div>
          </div>
          <div className="space-y-4">
            <div className="card p-4">
              <div className="panel-title mb-2">Exceptions</div>
              <CarExceptions exceptions={data.exceptions} />
            </div>
            {role !== 'shipper' && (
              <div className="card p-4">
                <div className="panel-title mb-2">Replanning sagas</div>
                <CarSagas sagas={data.sagas} />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
