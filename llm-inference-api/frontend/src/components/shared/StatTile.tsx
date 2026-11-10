import type { ReactNode } from 'react'

export function StatTile({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="card px-4 py-3">
      <div className="panel-title">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-slate-900 num">{value}</div>
      {hint !== undefined && <div className="mt-0.5 text-xs text-slate-500">{hint}</div>}
    </div>
  )
}

export function Meter({ value, max, tone = 'bg-accent-500', label }: { value: number; max: number; tone?: string; label?: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100" role="meter" aria-valuenow={value} aria-valuemax={max} aria-label={label}>
      <div className={`h-full ${tone}`} style={{ width: `${pct}%` }} />
    </div>
  )
}
