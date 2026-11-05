/**
 * Raw tank-sensor readings (de-emphasized dots) against the smoothed level
 * (the line the planner trusts). Two series, so a legend is shown and the
 * line is also labelled directly.
 */
import { useState } from 'react'
import { gal } from '@/lib/format'
import { useWidth } from '@/lib/use-width'
import type { TelemetryPoint } from '@/types'

const H = 220
const M = { top: 14, right: 70, bottom: 26, left: 52 }

export function SensorChart({ readings }: { readings: TelemetryPoint[] }) {
  const { ref, width } = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<TelemetryPoint | null>(null)
  // The measured wrapper must exist on the first render, or the width observer never attaches.
  if (readings.length < 2) return <div ref={ref} className="p-4 text-sm text-slate-500">Not enough readings yet.</div>
  const t0 = readings[0].t
  const t1 = readings[readings.length - 1].t
  const values = readings.flatMap((r) => [r.raw, r.smoothed ?? r.raw])
  const lo = Math.floor((Math.min(...values) - 100) / 250) * 250
  const hi = Math.ceil((Math.max(...values) + 100) / 250) * 250
  const innerW = width - M.left - M.right
  const innerH = H - M.top - M.bottom
  const x = (t: number) => M.left + ((t - t0) / Math.max(1, t1 - t0)) * innerW
  const y = (g: number) => M.top + innerH - ((g - lo) / (hi - lo)) * innerH
  const smooth = readings.filter((r) => r.smoothed !== null)
  const line = smooth.map((r, i) => `${i ? 'L' : 'M'}${x(r.t).toFixed(1)},${y(r.smoothed!).toFixed(1)}`).join(' ')
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => lo + f * (hi - lo))
  const last = smooth[smooth.length - 1]
  return (
    <div ref={ref} className="relative">
      <div className="mb-1 flex items-center gap-4 text-xs text-slate-600">
        <span className="flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-full bg-slate-400" /> Raw sensor (slosh, spikes, late readings hollow)</span>
        <span className="flex items-center gap-1.5"><span className="inline-block h-0.5 w-4 bg-[#2a78d6]" /> Smoothed level</span>
      </div>
      <svg
        width={width}
        height={H}
        role="img"
        aria-label="Raw versus smoothed fuel level"
        onMouseMove={(e) => {
          const px = e.clientX - (e.currentTarget as SVGElement).getBoundingClientRect().left
          setHover(readings.reduce((best, r) => (Math.abs(x(r.t) - px) < Math.abs(x(best.t) - px) ? r : best), readings[0]))
        }}
        onMouseLeave={() => setHover(null)}
      >
        {ticks.map((g) => (
          <g key={g}>
            <line x1={M.left} x2={width - M.right} y1={y(g)} y2={y(g)} stroke="#e2e8f0" />
            <text x={M.left - 6} y={y(g) + 4} textAnchor="end" className="fill-slate-500 text-[11px]">{Math.round(g).toLocaleString()}</text>
          </g>
        ))}
        {readings.map((r) => (
          <circle key={r.seq} cx={x(r.t)} cy={y(r.raw)} r={r.late ? 3.5 : 2.5} fill={r.late ? '#fff' : '#94a3b8'} stroke="#94a3b8" strokeWidth={r.late ? 1.5 : 0} />
        ))}
        <path d={line} fill="none" stroke="#2a78d6" strokeWidth={2} />
        {last && <text x={x(last.t) + 6} y={y(last.smoothed!) + 4} className="fill-slate-700 text-[11px]">Smoothed</text>}
        <text x={M.left} y={H - 6} className="fill-slate-500 text-[11px]">Older</text>
        <text x={width - M.right} y={H - 6} textAnchor="end" className="fill-slate-500 text-[11px]">Latest</text>
        {hover && <line x1={x(hover.t)} x2={x(hover.t)} y1={M.top} y2={M.top + innerH} stroke="#64748b" strokeWidth={1} pointerEvents="none" />}
      </svg>
      {hover && (
        <div className="pointer-events-none absolute top-6 whitespace-nowrap rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs shadow-sm" style={{ left: Math.max(0, Math.min(width - 300, x(hover.t) + 10)) }}>
          <div className="num text-slate-700">Raw {gal(hover.raw)} · smoothed {gal(hover.smoothed)}</div>
          <div className="num text-slate-500">MP {Math.round(hover.milepost)} · {Math.round(hover.speed)} mph · notch {hover.notch}{hover.late ? ' · late, not applied' : ''}</div>
        </div>
      )}
    </div>
  )
}
