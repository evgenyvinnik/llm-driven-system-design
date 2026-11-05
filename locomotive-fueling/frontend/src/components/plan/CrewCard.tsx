import { FuelIcon, TruckIcon } from '@/components/icons'
import { gal, relHours, simTime } from '@/lib/format'
import type { Plan } from '@/types'

/** Cab-tablet summary: the one thing the crew needs, large and plain. */
export function CrewCard({ plan, nowMs, milepost }: { plan: Plan | null; nowMs: number; milepost: number }) {
  const next = plan?.stops.find((s) => s.milepost >= milepost - 0.5)
  return (
    <div className="card flex items-center gap-4 border-accent-200 bg-accent-50 p-5" data-testid="crew-card">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-accent-600 text-white">
        {next?.kind === 'dtl' ? <TruckIcon className="h-6 w-6" /> : <FuelIcon className="h-6 w-6" />}
      </div>
      {next ? (
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-accent-700">Next fuel stop</div>
          <div className="text-2xl font-semibold text-slate-900">
            {next.name} <span className="text-base font-normal text-slate-600">{next.kind === 'dtl' ? 'DTL truck at the siding' : 'fuel pad'}</span>
          </div>
          <div className="num text-sm text-slate-700">
            Arrive {simTime(next.etaMs)} ({relHours(next.etaMs, nowMs)}) · take on about {gal(next.gallons)} ·{' '}
            {next.perUnit
              .filter((u) => u.gallons >= 1)
              .map((u) => `${u.locomotiveId} to ${Math.round(u.targetGal)}`)
              .join(', ')}
          </div>
          {plan?.lifecycle !== 'accepted' && <div className="mt-1 text-sm font-medium text-amber-800">Not yet accepted: acknowledge below so the bay and truck are reserved.</div>}
        </div>
      ) : (
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-accent-700">Next fuel stop</div>
          <div className="text-xl font-semibold text-slate-900">None needed before the destination</div>
        </div>
      )}
    </div>
  )
}
