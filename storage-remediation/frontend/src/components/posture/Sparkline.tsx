/** Compliance % for one control over time: a single 2px line, current value marked. */
export function Sparkline({ values, label }: { values: number[]; label: string }) {
  const W = 120
  const H = 28
  if (values.length < 2) return <span className="text-xs text-slate-400">—</span>
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const sx = (i: number) => 2 + (i / (values.length - 1)) * (W - 8)
  const sy = (v: number) => 3 + (1 - (v - min) / span) * (H - 6)
  const d = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${sx(i).toFixed(1)},${sy(v).toFixed(1)}`).join(' ')
  const first = values[0]
  const last = values[values.length - 1]
  return (
    <svg width={W} height={H} role="img" aria-label={`${label}: ${first.toFixed(1)}% to ${last.toFixed(1)}%`}>
      <title>{`${label}: ${first.toFixed(1)}% → ${last.toFixed(1)}%`}</title>
      <path d={d} fill="none" stroke="#2a78d6" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={sx(values.length - 1)} cy={sy(last)} r={2.5} fill="#2a78d6" />
    </svg>
  )
}
