import { createFileRoute, Link } from '@tanstack/react-router'
import { AlertIcon, ClockIcon } from '@/components/icons'
import { ConsistPanel } from '@/components/plan/ConsistPanel'
import { CostCard } from '@/components/plan/CostCard'
import { CrewCard } from '@/components/plan/CrewCard'
import { FuelProfileChart } from '@/components/plan/FuelProfileChart'
import { HistoryPanel } from '@/components/plan/HistoryPanel'
import { PlanHeader } from '@/components/plan/PlanHeader'
import { ProposalCard } from '@/components/plan/ProposalCard'
import { StopsTable } from '@/components/plan/StopsTable'
import { Severity } from '@/components/shared/Chips'
import { ErrorNote, Loading, StaleBanner } from '@/components/shared/Loading'
import { ageLabel, simTime } from '@/lib/format'
import { useRefresh } from '@/lib/use-refresh'
import { api } from '@/services/api'
import { useAuthStore } from '@/stores/auth-store'
import { useLiveStore } from '@/stores/live-store'

export const Route = createFileRoute('/trains/$trainId')({ component: TrainPage })

function TrainPage() {
  const { trainId } = Route.useParams()
  const user = useAuthStore((s) => s.user)
  const tick = useLiveStore((s) => s.trainTicks[trainId] ?? 0)
  const { data, error, stale, fetchedAt, reload } = useRefresh(() => api.train(trainId), { triggers: [tick], cacheKey: `train:${trainId}`, coalesceMs: 1500 })
  if (!user) return null
  if (!data) return error ? <ErrorNote message={error} /> : <Loading />
  const { train, plan, proposal } = data
  const isCrew = user.role === 'crew'
  const profile = data.projection?.projection ?? plan?.profile
  const openAlerts = data.alerts.filter((a) => a.status !== 'resolved')
  return (
    <div>
      {stale && <StaleBanner fetchedAt={fetchedAt} error={error} />}
      <div className="space-y-4 p-6">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            {!isCrew && (
              <Link to="/fleet" className="text-xs text-accent-700 hover:underline">
                ← Fleet
              </Link>
            )}
            <h1 className="text-xl font-semibold text-slate-900">
              {train.symbol} <span className="text-base font-normal text-slate-500">{train.origin} → {train.destination}</span>
            </h1>
            <p className="num text-sm text-slate-500">
              MP {Math.round(train.milepost)} of {train.totalMiles} · {Math.round(train.speedMph)} mph · {train.plannedTons.toLocaleString()} t planned · burn running ×
              {train.calibration.toFixed(2)} vs model · fuel data {ageLabel(train.lastSeenMs, data.simNow)}
            </p>
          </div>
          <div className="flex items-center gap-1.5 text-sm text-slate-500">
            <ClockIcon className="h-4 w-4" /> Sim time <span className="num font-medium text-slate-700">{simTime(data.simNow)}</span>
          </div>
        </div>

        {isCrew && <CrewCard plan={plan} nowMs={data.simNow} milepost={train.milepost} />}
        {openAlerts.length > 0 && (
          <div className="card divide-y divide-slate-100">
            {openAlerts.map((a) => (
              <div key={a.id} className="flex items-start gap-2 px-4 py-2 text-sm">
                <AlertIcon className="mt-0.5 h-4 w-4 text-slate-500" />
                <Severity severity={a.severity} />
                <span className="text-slate-700">{a.message}</span>
              </div>
            ))}
          </div>
        )}
        {plan ? (
          <>
            <PlanHeader trainId={trainId} plan={plan} role={user.role} canAccept={!isCrew || user.trainId === trainId} onChanged={reload} />
            {proposal && <ProposalCard trainId={trainId} proposal={proposal} current={plan} milepost={train.milepost} canConfirm={!isCrew} onChanged={reload} />}
            {profile && (
              <div className="card p-4">
                <div className="panel-title mb-1">
                  Projected consist fuel (expected burn) along the remaining route
                  {data.projection ? ` · as of the last evaluation, ${simTime(data.projection.evaluatedAt)}` : ''}
                </div>
                <FuelProfileChart profile={profile} path={train.path} currentMilepost={train.milepost} totalMiles={train.totalMiles} />
              </div>
            )}
            <StopsTable stops={plan.stops.filter((s) => s.milepost >= train.milepost - 0.5 || s.commitment === 'executing')} nowMs={data.simNow} />
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
              <CostCard plan={plan} />
              <ConsistPanel units={train.units} />
            </div>
            {!isCrew && <HistoryPanel versions={data.versions} evaluations={data.evaluations} />}
          </>
        ) : (
          <Loading label="Waiting for the first plan…" />
        )}
      </div>
    </div>
  )
}
