import { num } from '@/lib/format'
import type { TargetCounts } from '@/types'

const ITEMS: { key: keyof TargetCounts; label: string; hint: string }[] = [
  { key: 'verified', label: 'Verified', hint: 'baked cleanly' },
  { key: 'baking', label: 'Baking', hint: 'watching 403s' },
  { key: 'queued', label: 'Queued', hint: 'waiting for a worker' },
  { key: 'deferred', label: 'Deferred', hint: 'Retry-After / budget' },
  { key: 'rolled_back', label: 'Rolled back', hint: 'auth failures seen' },
  { key: 'escalated', label: 'Escalated', hint: 'changed since planning' },
  { key: 'failed', label: 'Failed', hint: 'counts against budget' },
  { key: 'throttles', label: '429s honored', hint: 'platform throttling' },
  { key: 'reconciled', label: 'Reconciled', hint: 'outcome confirmed by re-read' },
]

export function CounterRow({ counts }: { counts: TargetCounts }) {
  return (
    <div className="grid grid-cols-3 gap-2 md:grid-cols-5 xl:grid-cols-9">
      {ITEMS.map((i) => (
        <div key={i.key} className="card px-3 py-2">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{i.label}</div>
          <div className="text-lg font-semibold text-slate-900">{num(i.key === 'reconciled' ? (counts.reconciled ?? 0) + (counts.recovered ?? 0) : (counts[i.key] ?? 0))}</div>
          <div className="text-[11px] text-slate-400">{i.hint}</div>
        </div>
      ))}
    </div>
  )
}
