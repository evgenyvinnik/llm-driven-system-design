import { formatBytes, percent } from '@/lib/format'

export function QuotaBar({ used, capacity }: { used: number; capacity: number }) {
  const share = percent(used, capacity)
  const color = share >= 90 ? 'bg-red-500' : share >= 75 ? 'bg-amber-500' : 'bg-accent-500'
  return (
    <div className="w-full">
      <div className="h-2 rounded-full bg-slate-100" role="meter" aria-valuenow={share} aria-valuemin={0} aria-valuemax={100}>
        <div className={`h-2 rounded-full ${color}`} style={{ width: `${share}%` }} />
      </div>
      <p className="mt-1 text-xs tabular-nums text-slate-500">
        {formatBytes(used)} of {formatBytes(capacity)} · {share}%
      </p>
    </div>
  )
}
