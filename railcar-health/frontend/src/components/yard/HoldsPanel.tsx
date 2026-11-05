import { HoldBadge } from '@/components/shared/Badges'
import { Empty } from '@/components/shared/Loading'
import { TierBadge } from '@/components/shared/TierBadge'
import { ageText } from '@/lib/format'
import type { Hold } from '@/types'

export function HoldsPanel({ holds, nowMs }: { holds: Hold[]; nowMs: number }) {
  if (holds.length === 0) return <Empty>No holds at this yard.</Empty>
  return (
    <table className="w-full" aria-label="Car holds">
      <thead className="border-b border-slate-100">
        <tr><th className="th">Car</th><th className="th">Status</th><th className="th">Alert</th><th className="th">Reason</th><th className="th">Since</th></tr>
      </thead>
      <tbody className="divide-y divide-slate-50">
        {holds.map((h) => (
          <tr key={h.id} className={h.status === 'released' ? 'opacity-60' : ''}>
            <td className="td font-mono">{h.carId}</td>
            <td className="td">{h.status === 'released' ? <span className="text-xs text-slate-500">released{h.releasedBy ? ` by ${h.releasedBy}` : ''}</span> : <HoldBadge status={h.status} />}</td>
            <td className="td"><TierBadge tier={h.tier} /> <span className="text-xs text-slate-500">{h.kind === 'hot_wheel' ? 'wheels' : h.position}</span></td>
            <td className="td text-xs">{h.reason}</td>
            <td className="td text-xs">{ageText(h.createdAt, nowMs)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
