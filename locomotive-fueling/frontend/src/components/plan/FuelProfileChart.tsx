/**
 * Projected consist fuel along the remaining route: a single series (the
 * title names it, so no legend box), the reserve as a labelled threshold, a
 * "now" marker, and fuel stops as labelled markers. Hover shows a crosshair
 * and the values at that milepost.
 */
import { useState } from 'react'
import { gal } from '@/lib/format'
import { useWidth } from '@/lib/use-width'
import type { PathNode, Profile } from '@/types'

const H = 250
const M = { top: 16, right: 16, bottom: 46, left: 56 }

export function FuelProfileChart({ profile, path, currentMilepost, totalMiles }: { profile: Profile; path: PathNode[]; currentMilepost: number; totalMiles: number }) {
  const { ref, width } = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const innerW = width - M.left - M.right
  const innerH = H - M.top - M.bottom
  const x = (mile: number) => M.left + (mile / totalMiles) * innerW
  const y = (g: number) => M.top + innerH - (g / profile.capacityGal) * innerH
  const pts = profile.points
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.milepost).toFixed(1)},${y(p.fuelGal).toFixed(1)}`).join(' ')
  const stops = pts.filter((p) => p.kind === 'depart')
  const grid = [0.25, 0.5, 0.75, 1].map((f) => f * profile.capacityGal)

  /** Fuel at a milepost: linear between projected points (vertical jumps at stops). */
  const fuelAt = (mile: number) => {
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]
      const b = pts[i]
      if (mile >= a.milepost && mile <= b.milepost && b.milepost > a.milepost) return a.fuelGal + ((mile - a.milepost) / (b.milepost - a.milepost)) * (b.fuelGal - a.fuelGal)
    }
    return null
  }
  const hoverFuel = hover === null ? null : fuelAt(hover)
  const nearNode = hover === null ? null : path.reduce((best, n) => (Math.abs(n.milepost - hover) < Math.abs(best.milepost - hover) ? n : best), path[0])

  return (
    <div ref={ref} className="relative">
      <svg
        width={width}
        height={H}
        role="img"
        aria-label="Projected consist fuel by milepost with reserve line"
        onMouseMove={(e) => {
          const rect = (e.currentTarget as SVGElement).getBoundingClientRect()
          const mile = ((e.clientX - rect.left - M.left) / innerW) * totalMiles
          setHover(mile >= currentMilepost && mile <= totalMiles ? mile : null)
        }}
        onMouseLeave={() => setHover(null)}
      >
        {grid.map((g) => (
          <g key={g}>
            <line x1={M.left} x2={width - M.right} y1={y(g)} y2={y(g)} stroke="#e2e8f0" strokeWidth={1} />
            <text x={M.left - 6} y={y(g) + 4} textAnchor="end" className="fill-slate-500 text-[11px]">
              {Math.round(g / 1000)}k
            </text>
          </g>
        ))}
        <line x1={M.left} x2={width - M.right} y1={y(0)} y2={y(0)} stroke="#94a3b8" strokeWidth={1} />
        {path.map((n) => (
          <g key={n.locationId}>
            <line x1={x(n.milepost)} x2={x(n.milepost)} y1={y(0)} y2={y(0) + 4} stroke="#94a3b8" />
            <text x={x(n.milepost)} y={y(0) + 16} textAnchor="middle" className={`text-[10px] ${n.fuel.length ? 'fill-slate-700' : 'fill-slate-400'}`}>
              {n.locationId}
            </text>
          </g>
        ))}
        <text x={M.left + innerW / 2} y={H - 6} textAnchor="middle" className="fill-slate-500 text-[11px]">
          Miles along route (labelled stations; darker ones sell fuel)
        </text>
        <line x1={M.left} x2={width - M.right} y1={y(profile.reserveGal)} y2={y(profile.reserveGal)} stroke="#dc2626" strokeWidth={1.5} />
        <text x={width - M.right - 4} y={y(profile.reserveGal) - 5} textAnchor="end" className="fill-slate-700 text-[11px] font-medium">
          Reserve {gal(profile.reserveGal)}
        </text>
        <line x1={x(currentMilepost)} x2={x(currentMilepost)} y1={M.top} y2={y(0)} stroke="#475569" strokeWidth={1} />
        <text x={x(currentMilepost) + 4} y={M.top + 10} className="fill-slate-600 text-[11px]">
          Now
        </text>
        <path d={line} fill="none" stroke="#2a78d6" strokeWidth={2} strokeLinejoin="round" />
        {stops.map((s) => (
          <g key={`${s.milepost}`}>
            <circle cx={x(s.milepost)} cy={y(s.fuelGal)} r={5} fill="#2a78d6" stroke="#fff" strokeWidth={2} />
            <text x={x(s.milepost)} y={y(s.fuelGal) - 9} textAnchor="middle" className="fill-slate-700 text-[11px] font-medium">
              Fuel at {s.locationId}
            </text>
          </g>
        ))}
        {hover !== null && hoverFuel !== null && (
          <g pointerEvents="none">
            <line x1={x(hover)} x2={x(hover)} y1={M.top} y2={y(0)} stroke="#64748b" strokeDasharray="0" strokeWidth={1} />
            <circle cx={x(hover)} cy={y(hoverFuel)} r={4} fill="#2a78d6" stroke="#fff" strokeWidth={2} />
          </g>
        )}
      </svg>
      {hover !== null && hoverFuel !== null && (
        <div className="pointer-events-none absolute top-2 whitespace-nowrap rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs shadow-sm" style={{ left: Math.min(width - 170, x(hover) + 10) }}>
          <div className="font-medium text-slate-800">Mile {Math.round(hover)}{nearNode ? ` · near ${nearNode.name}` : ''}</div>
          <div className="num text-slate-600">
            {gal(hoverFuel)} ({Math.round((hoverFuel / profile.capacityGal) * 100)}% of consist)
          </div>
          <div className="num text-slate-500">{gal(hoverFuel - profile.reserveGal)} above reserve</div>
        </div>
      )}
    </div>
  )
}
