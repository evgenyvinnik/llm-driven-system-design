import { fmtShort, hoursBetween } from '@/lib/format'

interface Props {
  p10: string
  p50: string
  p90: string
  now: string
  /** Where the plan originally said the car would arrive at its destination yard. */
  planned?: string | null
  /** Hours shown across the bar, starting at `now`. */
  spanHours?: number
}

/**
 * The ETA as a range: the bar covers the 80% band (p10–p90), the tick is the median, the dashed line is the
 * original plan. Uncertainty is the point; a single timestamp would hide it.
 */
export function EtaRange({ p10, p50, p90, now, planned, spanHours = 96 }: Props) {
  const x = (iso: string) => Math.max(0, Math.min(100, (hoursBetween(iso, now) / spanHours) * 100))
  const left = x(p10)
  const right = x(p90)
  return (
    <div className="w-full min-w-[180px]">
      <div className="relative h-3 rounded-full bg-slate-100" aria-label={`ETA ${fmtShort(p50)}, likely between ${fmtShort(p10)} and ${fmtShort(p90)}`}>
        <div className="absolute inset-y-0 rounded-full bg-accent-200" style={{ left: `${left}%`, width: `${Math.max(1.5, right - left)}%` }} />
        <div className="absolute -top-0.5 h-4 w-1 rounded bg-accent-700" style={{ left: `calc(${x(p50)}% - 2px)` }} />
        {planned && <div className="absolute -top-1 h-5 border-l-2 border-dashed border-slate-500" style={{ left: `${x(planned)}%` }} title={`Original plan ${fmtShort(planned)}`} />}
      </div>
      <div className="mt-0.5 flex justify-between text-[11px] text-slate-500">
        <span>{fmtShort(p10)}</span>
        <span className="font-medium text-slate-800">{fmtShort(p50)}</span>
        <span>{fmtShort(p90)}</span>
      </div>
    </div>
  )
}
