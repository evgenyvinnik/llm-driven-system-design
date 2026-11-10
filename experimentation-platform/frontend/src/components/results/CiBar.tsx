/** A conversion rate with its 95% interval on a shared axis, so arms can be compared by eye. */
export function CiBar({ rate, ci, max, tone }: { rate: number; ci: [number, number]; max: number; tone: string }) {
  const x = (v: number) => `${Math.min(100, (v / max) * 100)}%`
  return (
    <div className="relative h-5 w-full min-w-[160px]" role="img" aria-label={`${(rate * 100).toFixed(2)}% (95% CI ${(ci[0] * 100).toFixed(2)}–${(ci[1] * 100).toFixed(2)}%)`}>
      <div className="absolute inset-x-0 top-1/2 h-px bg-slate-200" />
      <div className={`absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full opacity-40 ${tone}`} style={{ left: x(ci[0]), width: `calc(${x(ci[1])} - ${x(ci[0])})` }} />
      <div className={`absolute top-1/2 h-3.5 w-1 -translate-x-1/2 -translate-y-1/2 rounded ${tone}`} style={{ left: x(rate) }} />
    </div>
  )
}
