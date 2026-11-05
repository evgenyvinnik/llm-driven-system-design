import { useMemo, useState } from 'react'
import { num, shortDate } from '@/lib/format'
import { useWidth } from '@/lib/use-width'
import type { PosturePoint } from '@/types'

const H = 220
const PAD = { top: 16, right: 56, bottom: 26, left: 48 }

/**
 * Open findings over time: one series, so no legend (the card title names it).
 * Time axis is real time, so the minute-level scan snapshots of today sit at the
 * right edge. Seeded history (before the first scan) is marked with a shaded band.
 */
export function BurnDownChart({ points }: { points: PosturePoint[] }) {
  const { ref, width } = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const geo = useMemo(() => {
    if (points.length === 0) return null
    const xs = points.map((p) => Date.parse(p.takenAt))
    const x0 = Math.min(...xs)
    const x1 = Math.max(...xs, x0 + 1)
    const raw = Math.max(...points.map((p) => p.open)) || 1
    const magnitude = 10 ** Math.floor(Math.log10(raw / 4))
    const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => raw / s <= 5) ?? magnitude * 10
    const yMax = Math.ceil(raw / step) * step
    const sx = (t: number) => PAD.left + ((t - x0) / (x1 - x0)) * (width - PAD.left - PAD.right)
    const sy = (v: number) => PAD.top + (1 - v / yMax) * (H - PAD.top - PAD.bottom)
    const ticks = Array.from({ length: Math.round(yMax / step) + 1 }, (_, i) => Math.round(i * step))
    const seeded = points.filter((p) => p.source === 'seed').map((p) => Date.parse(p.takenAt))
    return { xs, sx, sy, ticks, x0, x1, seeded }
  }, [points, width])

  if (!geo) return <div ref={ref} className="p-6 text-sm text-slate-500">No posture snapshots yet.</div>
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${geo.sx(geo.xs[i]).toFixed(1)},${geo.sy(p.open).toFixed(1)}`).join(' ')
  const last = points[points.length - 1]
  const hovered = hover === null ? null : points[hover]

  function onMove(e: React.MouseEvent<SVGRectElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left + PAD.left
    let best = 0
    for (let i = 1; i < geo!.xs.length; i++) if (Math.abs(geo!.sx(geo!.xs[i]) - x) < Math.abs(geo!.sx(geo!.xs[best]) - x)) best = i
    setHover(best)
  }

  return (
    <div ref={ref} className="relative">
      <svg width={width} height={H} role="img" aria-label={`Open findings over time, now ${last.open}`}>
        {geo.seeded.length > 1 && (
          <g>
            <rect x={geo.sx(Math.min(...geo.seeded))} y={PAD.top} width={geo.sx(Math.max(...geo.seeded)) - geo.sx(Math.min(...geo.seeded))} height={H - PAD.top - PAD.bottom} fill="#f1f5f9" />
            <text x={geo.sx(Math.min(...geo.seeded)) + 6} y={PAD.top + 12} className="fill-slate-400 text-[10px]">seeded history (before first scan)</text>
          </g>
        )}
        {geo.ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={width - PAD.right} y1={geo.sy(t)} y2={geo.sy(t)} stroke="#e8eaee" />
            <text x={PAD.left - 8} y={geo.sy(t) + 3} textAnchor="end" className="fill-slate-500 text-[10px]">{num(t)}</text>
          </g>
        ))}
        {[geo.x0, (geo.x0 + geo.x1) / 2, geo.x1].map((t, i) => (
          <text key={i} x={geo.sx(t)} y={H - 8} textAnchor={i === 0 ? 'start' : i === 2 ? 'end' : 'middle'} className="fill-slate-500 text-[10px]">{shortDate(new Date(t).toISOString())}</text>
        ))}
        <path d={path} fill="none" stroke="#2a78d6" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={geo.sx(geo.xs[geo.xs.length - 1])} cy={geo.sy(last.open)} r={4} fill="#2a78d6" stroke="#fff" strokeWidth={2} />
        <text x={geo.sx(geo.xs[geo.xs.length - 1]) + 8} y={geo.sy(last.open) + 4} className="fill-slate-700 text-[11px] font-semibold">{num(last.open)}</text>
        {hovered && hover !== null && (
          <g pointerEvents="none">
            <line x1={geo.sx(geo.xs[hover])} x2={geo.sx(geo.xs[hover])} y1={PAD.top} y2={H - PAD.bottom} stroke="#94a3b8" />
            <circle cx={geo.sx(geo.xs[hover])} cy={geo.sy(hovered.open)} r={4} fill="#2a78d6" stroke="#fff" strokeWidth={2} />
          </g>
        )}
        <rect x={PAD.left} y={PAD.top} width={width - PAD.left - PAD.right} height={H - PAD.top - PAD.bottom} fill="transparent" onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
      </svg>
      {hovered && hover !== null && (
        <div className="pointer-events-none absolute top-2 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs shadow-sm" style={{ left: Math.min(geo.sx(geo.xs[hover]) + 10, width - 170) }}>
          <div className="font-medium text-slate-800">{new Date(hovered.takenAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
          <div className="text-slate-600">{num(hovered.open)} open findings</div>
          <div className="text-slate-500">{((hovered.compliant / Math.max(1, hovered.total)) * 100).toFixed(1)}% of checks passing{hovered.source === 'seed' ? ' · seeded' : ''}</div>
        </div>
      )}
    </div>
  )
}
