import { pct } from '@/lib/format'

/** Success rate as a thin bar plus the number (the number carries the meaning). */
export function SuccessBar({ rate, attempts }: { rate: number | null; attempts: number }) {
  if (rate === null) return <span className="text-xs text-slate-400">no attempts in 1 h</span>
  const width = Math.max(2, Math.round(rate * 100))
  const color = rate >= 0.99 ? 'bg-emerald-500' : rate >= 0.8 ? 'bg-amber-500' : 'bg-red-500'
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-slate-100" aria-hidden>
        <div className={`h-full ${color}`} style={{ width: `${width}%` }} />
      </div>
      <span className="num text-xs text-slate-700">
        {pct(rate)} <span className="text-slate-400">of {attempts}</span>
      </span>
    </div>
  )
}
