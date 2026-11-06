import { fmtTime, label } from '@/lib/format'
import type { Leg, PlanVersionRow } from '@/types'

function LegRow({ leg, changed }: { leg: Leg; changed: boolean }) {
  return (
    <li className={`flex items-center justify-between gap-2 rounded px-2 py-1 text-xs ${changed ? 'bg-amber-50' : ''}`}>
      <span className="font-mono font-medium text-slate-800">{leg.runId}</span>
      <span className="text-slate-600">
        {leg.fromYard} {fmtTime(leg.plannedDeparture)} → {leg.toYard} {fmtTime(leg.plannedArrival)}
      </span>
    </li>
  )
}

/** Every version of the trip plan, newest first, with the reason for each change. */
export function PlanVersions({ versions, current }: { versions: PlanVersionRow[]; current: number }) {
  const ordered = [...versions].sort((a, b) => b.version - a.version)
  return (
    <ol className="space-y-3" aria-label="Plan versions">
      {ordered.map((v) => {
        const prev = versions.find((p) => p.version === v.version - 1)
        return (
          <li key={v.version} className={`rounded-lg border p-3 ${v.version === current ? 'border-slate-900' : 'border-slate-200 opacity-80'}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="chip bg-slate-900 text-white">v{v.version}</span>
                <span className="text-sm font-medium text-slate-800">{label(v.reason_code)}</span>
                {v.version === current && <span className="chip bg-emerald-50 text-emerald-800">current</span>}
              </div>
              <span className="text-xs text-slate-500">
                {fmtTime(v.occurred_at)} · by {v.revised_by}
              </span>
            </div>
            <p className="mt-1 text-sm text-slate-600">{v.reason_text}</p>
            <ul className="mt-2 space-y-0.5">
              {v.legs.map((leg) => (
                <LegRow key={leg.seq} leg={leg} changed={!!prev && prev.legs.find((l) => l.seq === leg.seq)?.runId !== leg.runId} />
              ))}
            </ul>
          </li>
        )
      })}
    </ol>
  )
}
