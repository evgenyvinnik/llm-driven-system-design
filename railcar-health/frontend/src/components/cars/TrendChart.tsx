/**
 * One bearing across the detectors of each trip (x = miles from origin), one
 * line per trip. Dashed lines mark the illustrative tier thresholds.
 */
import { useState } from 'react'
import type { TrendSeries } from '@/types'

const COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4']
const W = 760
const H = 300
const M = { l: 48, r: 120, t: 16, b: 34 }

export type TrendMode = 'median' | 'ambient'
const REFS: Record<TrendMode, Array<[number, string]>> = {
  median: [[20, 'LOW (elevated)'], [35, 'MEDIUM level'], [60, 'HIGH (with rise)']],
  ambient: [[150, 'HIGH'], [195, 'CRITICAL / detector alarm']],
}

export function TrendChart({ series, mode }: { series: TrendSeries[]; mode: TrendMode }) {
  const [hover, setHover] = useState<{ x: number; y: number; text: string } | null>(null)
  const value = (p: TrendSeries['points'][number]) => (mode === 'median' ? p.sideDelta : p.aboveAmbient)
  const all = series.flatMap((s) => s.points.map(value)).filter((v): v is number => v !== null)
  const refs = REFS[mode]
  const rawMax = Math.max(...all, ...refs.map((r) => r[0])) + 10
  const rawMin = Math.min(0, ...all) - 5
  const step = [5, 10, 20, 25, 50, 100].find((s) => (rawMax - rawMin) / s <= 6) ?? 100
  const yMin = Math.floor(rawMin / step) * step
  const yMax = Math.ceil(rawMax / step) * step
  const sx = (d: number) => M.l + (d / 240) * (W - M.l - M.r)
  const sy = (v: number) => M.t + (1 - (v - yMin) / (yMax - yMin)) * (H - M.t - M.b)
  const ticks = Array.from({ length: Math.round((yMax - yMin) / step) + 1 }, (_, i) => yMin + i * step)
  return (
    <div className="relative">
      <svg width={W} height={H} role="img" aria-label="Bearing temperature trend across detectors and trips">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={M.l} x2={W - M.r} y1={sy(t)} y2={sy(t)} stroke="#f1f5f9" />
            <text x={M.l - 6} y={sy(t) + 4} fontSize={10} textAnchor="end" fill="#64748b">{t}°</text>
          </g>
        ))}
        {[0, 40, 80, 120, 160, 200, 240].map((d) => (
          <text key={d} x={sx(d)} y={H - M.b + 16} fontSize={10} textAnchor="middle" fill="#64748b">{d}</text>
        ))}
        <text x={(W - M.r + M.l) / 2} y={H - 4} fontSize={10} textAnchor="middle" fill="#64748b">miles from origin yard</text>
        {refs.map(([v, label]) => (
          <g key={v}>
            <line x1={M.l} x2={W - M.r} y1={sy(v)} y2={sy(v)} stroke="#94a3b8" strokeDasharray="4 4" />
            <text x={W - M.r + 4} y={sy(v) + 4} fontSize={10} fill="#475569">{label}</text>
          </g>
        ))}
        {series.map((s, i) => {
          const pts = s.points.filter((p) => value(p) !== null)
          const color = COLORS[i % COLORS.length]
          const last = pts.at(-1)
          return (
            <g key={s.tripId}>
              <polyline fill="none" stroke={color} strokeWidth={2} points={pts.map((p) => `${sx(p.distance)},${sy(value(p)!)}`).join(' ')} />
              {pts.map((p) => (
                <circle key={p.detectorId + p.passedAt} cx={sx(p.distance)} cy={sy(value(p)!)} r={4} fill={p.superseded ? '#fff' : color} stroke={p.superseded ? color : '#fff'} strokeWidth={2}
                  onMouseEnter={() => setHover({ x: sx(p.distance), y: sy(value(p)!), text: `${s.symbol} · ${p.detectorId} (MP ${p.milepost}) · ${Math.round(value(p)!)}°F${p.lagSeconds > 900 ? ' · arrived late' : ''}${p.superseded ? ' · previous wheelset (not evidence)' : ''}` })}
                  onMouseLeave={() => setHover(null)} />
              ))}
              {last && i < 4 && <text x={sx(last.distance) + 7} y={sy(value(last)!) + 4} fontSize={10} fill="#334155">{s.symbol}</text>}
            </g>
          )
        })}
      </svg>
      <div className="mt-1 flex flex-wrap gap-3 text-xs text-slate-600">
        {series.some((s) => s.points.some((p) => p.superseded)) && (
          <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-slate-500 bg-white" /> measured on a wheelset since replaced</span>
        )}
        {series.map((s, i) => (
          <span key={s.tripId} className="flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-4" style={{ background: COLORS[i % COLORS.length] }} />
            {s.symbol} {s.direction} · {new Date(s.departedAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}
          </span>
        ))}
      </div>
      {hover && <div className="pointer-events-none absolute rounded bg-slate-900 px-2 py-1 text-xs text-white" style={{ left: hover.x + 10, top: hover.y - 30 }}>{hover.text}</div>}
    </div>
  )
}
