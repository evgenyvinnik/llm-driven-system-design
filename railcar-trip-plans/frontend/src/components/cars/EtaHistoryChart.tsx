import { fmtShort } from '@/lib/format'
import type { EtaHistoryRow } from '@/types'

/**
 * How the prediction evolved: x is when the prediction was made (event time), y is the predicted delivery
 * time; the band is p10–p90. Vertical markers show plan version changes.
 */
export function EtaHistoryChart({ history }: { history: EtaHistoryRow[] }) {
  const rows = history.filter((h, i) => i === 0 || h.p50 !== history[i - 1].p50 || h.p10 !== history[i - 1].p10 || h.plan_version !== history[i - 1].plan_version)
  if (rows.length < 2) return <p className="text-sm text-slate-500">Not enough predictions yet to chart.</p>
  const W = 640
  const H = 180
  const pad = { l: 64, r: 12, t: 10, b: 28 }
  const xs = rows.map((r) => Date.parse(r.as_of))
  const ys = rows.flatMap((r) => [Date.parse(r.p10), Date.parse(r.p90)])
  const [x0, x1] = [Math.min(...xs), Math.max(...xs) || Math.min(...xs) + 1]
  const [y0, y1] = [Math.min(...ys), Math.max(...ys)]
  const sx = (v: number) => pad.l + ((v - x0) / Math.max(1, x1 - x0)) * (W - pad.l - pad.r)
  const sy = (v: number) => pad.t + (1 - (v - y0) / Math.max(1, y1 - y0)) * (H - pad.t - pad.b)
  const pts = (key: 'p10' | 'p50' | 'p90') => rows.map((r) => `${sx(Date.parse(r.as_of)).toFixed(1)},${sy(Date.parse(r[key])).toFixed(1)}`)
  const band = [...pts('p90'), ...pts('p10').reverse()].join(' ')
  const versionChanges = rows.filter((r, i) => i > 0 && r.plan_version !== rows[i - 1].plan_version)
  const ticks = [y0, (y0 + y1) / 2, y1]
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="ETA prediction history">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={pad.l} x2={W - pad.r} y1={sy(t)} y2={sy(t)} stroke="#e2e8f0" />
          <text x={pad.l - 6} y={sy(t) + 3} textAnchor="end" fontSize="10" fill="#64748b">{fmtShort(new Date(t).toISOString())}</text>
        </g>
      ))}
      <polygon points={band} fill="#bfdbfe" opacity="0.7" />
      <polyline points={pts('p50').join(' ')} fill="none" stroke="#1c5cab" strokeWidth="2" />
      {versionChanges.map((r) => (
        <g key={r.as_of + r.plan_version}>
          <line x1={sx(Date.parse(r.as_of))} x2={sx(Date.parse(r.as_of))} y1={pad.t} y2={H - pad.b} stroke="#d97706" strokeDasharray="3 3" />
          <text x={sx(Date.parse(r.as_of)) + 3} y={pad.t + 10} fontSize="10" fill="#b45309">v{r.plan_version}</text>
        </g>
      ))}
      <text x={pad.l} y={H - 8} fontSize="10" fill="#64748b">{fmtShort(new Date(x0).toISOString())}</text>
      <text x={W - pad.r} y={H - 8} fontSize="10" fill="#64748b" textAnchor="end">predicted at {fmtShort(new Date(x1).toISOString())}</text>
    </svg>
  )
}
