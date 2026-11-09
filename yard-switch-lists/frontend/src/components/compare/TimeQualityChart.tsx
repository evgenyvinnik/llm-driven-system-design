import { useState } from 'react'
import type { ComparisonRow } from '@/types'

/**
 * One series, one axis: plan cost against solve time, on a log time axis because
 * the budgets span two orders of magnitude. The title names the series, so it
 * needs no legend. Colors come from the dataviz reference palette; the hover
 * layer has a hit target larger than the marker, and the table beside it is the
 * accessible view.
 */
const W = 620
const H = 240
const PAD = { left: 56, right: 16, top: 16, bottom: 36 }

export function TimeQualityChart({ rows, greedyCost }: { rows: ComparisonRow[]; greedyCost: number | null }) {
  const [hover, setHover] = useState<number | null>(null)
  if (rows.length === 0) return null
  const xs = rows.map((r) => Math.max(1, r.elapsedMs))
  const costs = [...rows.map((r) => r.cost), ...(greedyCost !== null ? [greedyCost] : [])]
  const lo = Math.min(...costs)
  const hi = Math.max(...costs)
  const span = hi - lo || 1
  const x0 = Math.log10(Math.min(...xs))
  const x1 = Math.log10(Math.max(...xs)) || x0 + 1
  const px = (ms: number) => PAD.left + ((Math.log10(Math.max(1, ms)) - x0) / (x1 - x0 || 1)) * (W - PAD.left - PAD.right)
  const py = (c: number) => PAD.top + (1 - (c - lo) / span) * (H - PAD.top - PAD.bottom)
  const points = rows.map((r) => [px(r.elapsedMs), py(r.cost)] as const)
  const shown = hover !== null ? rows[hover] : null
  return (
    <figure className="card p-3">
      <figcaption className="panel-title mb-1">Local search on a full shift: plan cost against solve time (lower is better)</figcaption>
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Plan cost falls as the solve time budget grows">
          {[0, 0.5, 1].map((f) => {
            const c = lo + f * span
            return (
              <g key={f}>
                <line x1={PAD.left} x2={W - PAD.right} y1={py(c)} y2={py(c)} stroke="#e2e8f0" />
                <text x={PAD.left - 6} y={py(c) + 4} textAnchor="end" fontSize="11" fill="#64748b">{Math.round(c).toLocaleString()}</text>
              </g>
            )
          })}
          {greedyCost !== null && (
            <g>
              <line x1={PAD.left} x2={W - PAD.right} y1={py(greedyCost)} y2={py(greedyCost)} stroke="#64748b" strokeDasharray="4 4" />
              <text x={W - PAD.right} y={py(greedyCost) - 5} textAnchor="end" fontSize="11" fill="#475569">Greedy heuristic</text>
            </g>
          )}
          <polyline points={points.map((p) => p.join(',')).join(' ')} fill="none" stroke="#2a78d6" strokeWidth={2} />
          {rows.map((r, i) => (
            <g key={i} onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)}>
              <circle cx={points[i][0]} cy={points[i][1]} r={14} fill="transparent" />
              <circle cx={points[i][0]} cy={points[i][1]} r={4} fill="#2a78d6" stroke="#fff" strokeWidth={2} />
              <text x={points[i][0]} y={H - 20} textAnchor="middle" fontSize="11" fill="#64748b">{r.elapsedMs >= 1000 ? `${(r.elapsedMs / 1000).toFixed(1)} s` : `${r.elapsedMs} ms`}</text>
            </g>
          ))}
          <text x={(W + PAD.left) / 2} y={H - 4} textAnchor="middle" fontSize="11" fill="#475569">Solve time (log scale)</text>
        </svg>
        {shown && hover !== null && (
          <div className="pointer-events-none absolute rounded-md border border-slate-200 bg-white px-2 py-1 text-xs shadow" style={{ left: `${(points[hover][0] / W) * 100}%`, top: 4, transform: 'translateX(-50%)' }}>
            Budget {shown.timeLimitMs} ms · cost {shown.cost.toFixed(1)} · {shown.iterations.toLocaleString()} iterations · ended by {shown.terminatedBy.replace('_', ' ')}
          </div>
        )}
      </div>
    </figure>
  )
}
