import { pct } from '@/lib/format'
import type { MembershipChange } from '@/types'

/** Share of the key space each backend owns now, and what a membership change moves. */
export function RingShares({ shares, title }: { shares: Record<string, number>; title: string }) {
  const ids = Object.keys(shares)
  return (
    <div>
      <div className="mb-1 text-xs font-semibold text-slate-600">{title}</div>
      <div className="flex h-6 overflow-hidden rounded-md" role="img" aria-label={title}>
        {ids.map((id, i) => (
          <div key={id} className={`flex items-center justify-center text-[11px] font-medium text-white ${['bg-sky-600', 'bg-violet-600', 'bg-teal-600', 'bg-orange-500'][i % 4]}`} style={{ width: `${shares[id] * 100}%` }}>
            {id} {pct(shares[id])}
          </div>
        ))}
      </div>
    </div>
  )
}

export function MovementCard({ label, change, current }: { label: string; change: MembershipChange; current: Record<string, number> }) {
  return (
    <div className="card space-y-3 p-4">
      <h3 className="text-sm font-semibold text-slate-900">{label}</h3>
      <RingShares shares={current} title="Before" />
      <RingShares shares={change.shares} title="After" />
      <div className="grid grid-cols-2 gap-3 text-center">
        <div className="rounded-md bg-emerald-50 p-2">
          <div className="num text-xl font-semibold text-emerald-800">{pct(change.movedConsistent)}</div>
          <div className="text-xs text-emerald-900">of prefix keys move (consistent hashing)</div>
        </div>
        <div className="rounded-md bg-red-50 p-2">
          <div className="num text-xl font-semibold text-red-800">{pct(change.movedModulo)}</div>
          <div className="text-xs text-red-900">would move with hash mod N</div>
        </div>
      </div>
      <p className="text-xs text-slate-500">
        A moved key costs one cold-cache prefill on its new owner; nothing breaks, because affinity is a performance preference. Sampled over {change.keys.toLocaleString('en-US')} keys.
      </p>
    </div>
  )
}
