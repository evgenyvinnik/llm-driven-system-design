const BUCKETS = [250, 500, 750, 1000, 1500, 2000, 3000, 5000, 10000]

/** Distribution of detection-to-alert times (live alerts). */
export function Histogram({ values, budgetMs }: { values: number[]; budgetMs: number }) {
  const counts = BUCKETS.map((b, i) => values.filter((v) => v <= b && (i === 0 || v > BUCKETS[i - 1])).length)
  counts.push(values.filter((v) => v > BUCKETS[BUCKETS.length - 1]).length)
  const max = Math.max(1, ...counts)
  const labels = [...BUCKETS.map((b) => (b < 1000 ? `≤${b}ms` : `≤${b / 1000}s`)), '>10s']
  const W = 520
  const H = 160
  const bw = (W - 40) / counts.length
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Latency histogram">
      {counts.map((c, i) => {
        const h = (c / max) * (H - 40)
        const over = (BUCKETS[i] ?? Infinity) > budgetMs
        return (
          <g key={i}>
            <rect x={30 + i * bw + 3} y={H - 24 - h} width={bw - 6} height={h} rx={2} fill={over ? '#f87171' : '#0ea5e9'} />
            {c > 0 && (
              <text x={30 + i * bw + bw / 2} y={H - 28 - h} textAnchor="middle" className="fill-slate-600 text-[10px]">
                {c}
              </text>
            )}
            <text x={30 + i * bw + bw / 2} y={H - 10} textAnchor="middle" className="fill-slate-500 text-[9px]">
              {labels[i]}
            </text>
          </g>
        )
      })}
      <line x1={30} x2={W - 10} y1={H - 24} y2={H - 24} stroke="#94a3b8" />
    </svg>
  )
}
