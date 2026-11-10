import { LockIcon } from '@/components/icons'
import type { LockView } from '@/types'

function describe(l: LockView): string {
  if (l.kind === 'move') return `Move ${l.moveKey} stays as it is`
  if (l.kind === 'car_track') return `${l.carId} must land on ${l.trackId}`
  return `${l.moveKey} stays ahead of ${l.beforeKey}`
}

export function LockList({ locks, onRelease }: { locks: LockView[]; onRelease: (l: LockView) => void }) {
  return (
    <section className="card" aria-label="Active locks">
      <h2 className="panel-title border-b border-slate-200 px-3 py-2">Locks · {locks.length}</h2>
      {locks.length === 0 && <p className="px-3 py-2 text-sm text-slate-500">No locks. The planner may change any move outside the frozen horizon.</p>}
      <ul className="divide-y divide-slate-100 text-sm">
        {locks.map((l) => (
          <li key={l.id} className="flex items-start gap-2 px-3 py-1.5">
            <LockIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent-700" />
            <div className="min-w-0 flex-1">
              <div className="truncate" title={describe(l)}>{describe(l)}</div>
              <div className="truncate text-xs text-slate-500" title={l.reason}>{l.by}: {l.reason}</div>
            </div>
            <button type="button" className="text-xs text-accent-700 hover:underline" onClick={() => onRelease(l)}>Release</button>
          </li>
        ))}
      </ul>
    </section>
  )
}
