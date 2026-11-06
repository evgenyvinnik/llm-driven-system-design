/** Events committed per second over the last minute, as bars. */
export function Sparkline({ series }: { series: Array<{ t: number; n: number }> }) {
  const max = Math.max(1, ...series.map((s) => s.n))
  const w = 240
  const h = 40
  const bw = w / series.length
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-10 w-full" role="img" aria-label="Events per second, last 60 seconds">
      {series.map((s, i) => (
        <rect key={s.t} x={i * bw + 0.5} y={h - (s.n / max) * (h - 2)} width={Math.max(1, bw - 1)} height={(s.n / max) * (h - 2)} rx={1} className="fill-accent-500" />
      ))}
      <line x1={0} x2={w} y1={h - 0.5} y2={h - 0.5} className="stroke-slate-200" />
    </svg>
  )
}
