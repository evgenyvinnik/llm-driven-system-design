/**
 * A mean with its 95% interval on a fixed [0, 1] axis (or [-1, 1] for
 * differences, with zero marked). Text next to it carries the numbers.
 */
export function CiBar({ mean, ci, diverging = false, label }: { mean: number | null; ci: [number, number] | null; diverging?: boolean; label?: string }) {
  const lo = diverging ? -1 : 0
  const pos = (v: number) => `${((Math.min(1, Math.max(lo, v)) - lo) / (1 - lo)) * 100}%`
  const crosses = diverging && ci !== null && ci[0] <= 0 && ci[1] >= 0
  const tone = !diverging ? 'bg-accent-500' : crosses ? 'bg-slate-400' : (mean ?? 0) > 0 ? 'bg-emerald-500' : 'bg-rose-500'
  return (
    <div className="relative h-5 w-full" role="img" aria-label={label ?? 'confidence interval'}>
      <div className="absolute top-1/2 h-px w-full -translate-y-1/2 bg-slate-200" />
      {diverging && <div className="absolute top-0 h-5 w-px bg-slate-500" style={{ left: pos(0) }} />}
      {ci && <div className={`absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full opacity-40 ${tone}`} style={{ left: pos(ci[0]), width: `calc(${pos(ci[1])} - ${pos(ci[0])})` }} />}
      {mean !== null && <div className={`absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white ${tone}`} style={{ left: pos(mean) }} />}
    </div>
  )
}
