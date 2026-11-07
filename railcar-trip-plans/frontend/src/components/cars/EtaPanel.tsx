import { EtaConfidenceText } from '@/components/shared/Badges'
import { EtaRange } from '@/components/shared/EtaRange'
import { fmtHours, fmtTime, hoursBetween, relative } from '@/lib/format'
import type { EtaRow } from '@/types'

/** The current ETA, its uncertainty, and where the remaining time goes (yards vs trains). */
export function EtaPanel({ eta, now, originalArrival }: { eta: EtaRow | null; now: string; originalArrival: string | null }) {
  if (!eta) return <div className="card p-4 text-sm text-slate-500">No ETA yet: the plan has not been processed.</div>
  if (eta.final) {
    return (
      <div className="card p-4">
        <div className="panel-title">Delivered</div>
        <div className="mt-1 text-2xl font-semibold text-emerald-700">{fmtTime(eta.p50)}</div>
        {originalArrival && <div className="text-sm text-slate-500">the original plan expected delivery around {fmtTime(originalArrival)}</div>}
      </div>
    )
  }
  const b = eta.basis
  const drift = originalArrival ? hoursBetween(eta.p50, originalArrival) : null
  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="panel-title">ETA at destination</div>
          <div className="mt-1 text-2xl font-semibold text-slate-900">{fmtTime(eta.p50)}</div>
          <div className="text-sm text-slate-600">
            likely between {fmtTime(eta.p10)} and {fmtTime(eta.p90)} ({relative(eta.p50, now)}) · <EtaConfidenceText confidence={eta.confidence} />
          </div>
        </div>
        {drift !== null && (
          <div className="text-right">
            <div className="panel-title">vs original plan</div>
            <div className={`mt-1 text-xl font-semibold ${drift > 6 ? 'text-red-700' : drift > 2 ? 'text-amber-700' : 'text-slate-700'}`}>{fmtHours(drift)}</div>
          </div>
        )}
      </div>
      <div className="mt-4">
        <EtaRange p10={eta.p10} p50={eta.p50} p90={eta.p90} now={now} planned={originalArrival} spanHours={Math.max(48, hoursBetween(eta.p90, now) * 1.15)} />
      </div>
      <div className="mt-4 grid grid-cols-3 gap-3 border-t border-slate-100 pt-3 text-sm">
        <div>
          <div className="panel-title">Remaining time in yards</div>
          <div className="mt-1 flex items-center gap-2">
            <div className="h-2 flex-1 overflow-hidden rounded bg-slate-100">
              <div className="h-full bg-amber-400" style={{ width: `${Math.round(b.yardShare * 100)}%` }} />
            </div>
            <span className="font-medium">{Math.round(b.yardShare * 100)}%</span>
          </div>
          <div className="text-xs text-slate-500">{b.yardHours} h in yards vs {b.transitHours} h moving</div>
        </div>
        <div>
          <div className="panel-title">Misses next connection</div>
          <div className="mt-1 font-medium">{Math.round(b.missNextConnection * 100)}% of samples</div>
          <div className="text-xs text-slate-500">at {b.nextYard ?? 'destination'}</div>
        </div>
        <div>
          <div className="panel-title">As of</div>
          <div className="mt-1 font-medium">{fmtTime(eta.as_of)}</div>
          <div className="text-xs text-slate-500">newest relevant event · plan v{eta.plan_version}</div>
        </div>
      </div>
    </div>
  )
}
