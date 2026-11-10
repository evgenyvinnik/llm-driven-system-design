import { useMemo, useState } from 'react'
import { clock } from '@/lib/format'
import type { OpsOverview } from '@/types'

/** Fixed order, assigned by entity: a repository keeps its color however the data changes. */
const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948']
const W = 760
const H = 180
const PAD = { left: 30, right: 8, top: 8, bottom: 22 }

export function StartsChart({ timeline, repositories }: { timeline: OpsOverview['timeline']; repositories: string[] }) {
  const [hover, setHover] = useState<number | null>(null)
  const color = useMemo(() => new Map(repositories.map((name, i) => [name, SERIES[Math.min(i, SERIES.length - 1)]])), [repositories])
  const max = Math.max(1, ...timeline.map((b) => Object.values(b.starts).reduce((a, n) => a + n, 0)))
  const innerW = W - PAD.left - PAD.right
  const innerH = H - PAD.top - PAD.bottom
  const step = timeline.length > 0 ? innerW / timeline.length : innerW
  const barW = Math.max(3, Math.min(18, step - 2))
  const y = (v: number) => (v / max) * innerH
  const ticks = [0, Math.ceil(max / 2), max]
  const hovered = hover !== null ? timeline[hover] : null

  return (
    <div className="p-4">
      <div className="mb-2 flex flex-wrap items-center gap-3 text-xs text-slate-600" aria-label="Legend">
        {repositories.map((name) => (
          <span key={name} className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: color.get(name) }} /> {name}
          </span>
        ))}
      </div>
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Job starts per repository over time">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.left} x2={W - PAD.right} y1={H - PAD.bottom - y(t)} y2={H - PAD.bottom - y(t)} stroke="#e2e8f0" strokeWidth={1} />
              <text x={PAD.left - 6} y={H - PAD.bottom - y(t) + 3} fontSize={10} textAnchor="end" fill="#64748b">
                {t}
              </text>
            </g>
          ))}
          {timeline.map((bucket, i) => {
            let stacked = 0
            const x = PAD.left + i * step + (step - barW) / 2
            return (
              <g key={bucket.at} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                <rect x={PAD.left + i * step} y={PAD.top} width={step} height={innerH} fill={hover === i ? '#f1f5f9' : 'transparent'} />
                {repositories.map((name) => {
                  const value = bucket.starts[name] ?? 0
                  if (value === 0) return null
                  const height = y(value)
                  stacked += height
                  // A 2px surface gap between stacked segments.
                  return <rect key={name} x={x} y={H - PAD.bottom - stacked} width={barW} height={Math.max(1, height - 2)} rx={2} fill={color.get(name)} />
                })}
              </g>
            )
          })}
          {timeline.length > 0 && (
            <>
              <text x={PAD.left} y={H - 6} fontSize={10} fill="#64748b">
                {clock(timeline[0].at)}
              </text>
              <text x={W - PAD.right} y={H - 6} fontSize={10} textAnchor="end" fill="#64748b">
                {clock(timeline[timeline.length - 1].at)}
              </text>
            </>
          )}
        </svg>
        {hovered && hover !== null && (
          <div className="pointer-events-none absolute top-1 rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs shadow" style={{ left: `${Math.min(70, (hover / Math.max(1, timeline.length)) * 100)}%` }} role="tooltip">
            <div className="mb-0.5 font-medium text-slate-900">{clock(hovered.at)}</div>
            {repositories
              .filter((name) => (hovered.starts[name] ?? 0) > 0)
              .map((name) => (
                <div key={name} className="flex items-center gap-1.5 text-slate-700">
                  <span className="h-2 w-2 rounded-sm" style={{ background: color.get(name) }} /> {name}: {hovered.starts[name]}
                </div>
              ))}
          </div>
        )}
      </div>
      <p className="mt-1 text-xs text-slate-500">Jobs started per bucket. During a burst, every repository with work keeps appearing: the claim serves repositories in turn.</p>
    </div>
  )
}
