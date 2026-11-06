import { useState } from 'react'
import { CLASS_LABEL } from '@/lib/format'
import type { Analytics, ClientClass } from '@/types'

const SERIES: { key: ClientClass; color: string }[] = [
  { key: 'portal', color: '#2a78d6' },
  { key: 'api', color: '#eb6834' },
  { key: 'api_requote', color: '#1baf7a' },
]

const W = 760
const H = 220
const PAD = { top: 12, right: 8, bottom: 26, left: 36 }

/** 1, 2 or 5 times a power of ten, at least `raw`. */
function niceStep(raw: number): number {
  const pow = 10 ** Math.floor(Math.log10(Math.max(raw, 1)))
  return [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? 10 * pow
}

/** Bar with only the top corners rounded (4px), anchored to the baseline. */
function topRounded(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, h, w / 2)
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`
}

/** Quote requests per hour (event time) by client class, stacked. Values come from the analytics projection. */
export function VolumeChart({ hourly }: { hourly: Analytics['hourly'] }) {
  const [hover, setHover] = useState<number | null>(null)
  const now = new Date()
  now.setMinutes(0, 0, 0)
  const buckets = Array.from({ length: 24 }, (_, i) => new Date(now.getTime() - (23 - i) * 3_600_000).toISOString())
  const value = (bucket: string, cls: ClientClass) => hourly.find((h) => h.bucket === bucket && h.metric === 'requested' && h.dimension === cls)?.value ?? 0
  const rows = buckets.map((b) => ({ bucket: b, values: SERIES.map((s) => value(b, s.key)) }))
  const max = Math.max(4, ...rows.map((r) => r.values.reduce((a, v) => a + v, 0)))
  const step = niceStep(max / 4)
  const niceMax = step * Math.ceil(max / step)
  const plotW = W - PAD.left - PAD.right
  const plotH = H - PAD.top - PAD.bottom
  const slot = plotW / rows.length
  const barW = Math.max(4, slot - 6)
  const y = (v: number) => (v / niceMax) * plotH
  const ticks = Array.from({ length: Math.round(niceMax / step) + 1 }, (_, i) => i * step)
  const base = PAD.top + plotH

  return (
    <div className="relative">
      <div className="mb-2 flex gap-4 text-xs text-slate-600" aria-label="Legend">
        {SERIES.map((s) => (
          <span key={s.key} className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} /> {CLASS_LABEL[s.key]}
          </span>
        ))}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Quote requests per hour by client class, last 24 hours">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={base - y(t)} y2={base - y(t)} stroke="#e2e8f0" strokeWidth={1} />
            <text x={PAD.left - 6} y={base - y(t) + 3} textAnchor="end" fontSize={10} fill="#64748b">
              {t}
            </text>
          </g>
        ))}
        {rows.map((r, i) => {
          const x = PAD.left + i * slot + (slot - barW) / 2
          const topIdx = r.values.reduce((t, v, k) => (v > 0 ? k : t), -1)
          let acc = 0
          return (
            <g key={r.bucket} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={PAD.left + i * slot} y={PAD.top} width={slot} height={plotH} fill={hover === i ? '#f1f5f9' : 'transparent'} />
              {r.values.map((v, k) => {
                if (v === 0) return null
                const bottom = base - y(acc)
                acc += v
                const top = base - y(acc)
                // 2px surface gap above each segment that has another segment stacked on it.
                const gap = k !== topIdx && bottom - top > 4 ? 2 : 0
                const h = Math.max(1, bottom - top - gap)
                return k === topIdx ? (
                  <path key={k} d={topRounded(x, bottom - h, barW, h, 4)} fill={SERIES[k].color} />
                ) : (
                  <rect key={k} x={x} y={bottom - h} width={barW} height={h} fill={SERIES[k].color} />
                )
              })}
              {i % 3 === 0 && (
                <text x={x + barW / 2} y={H - 8} textAnchor="middle" fontSize={10} fill="#64748b">
                  {new Date(r.bucket).getHours().toString().padStart(2, '0')}:00
                </text>
              )}
            </g>
          )
        })}
      </svg>
      {hover !== null && (
        <div className="pointer-events-none absolute top-8 z-10 rounded-md border border-slate-200 bg-white px-3 py-2 text-xs shadow-md" style={{ left: `${Math.min(80, ((PAD.left + hover * slot) / W) * 100)}%` }}>
          <div className="mb-1 font-semibold text-slate-700">{new Date(rows[hover].bucket).toLocaleString('en-US', { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false })}</div>
          {SERIES.map((s, k) => (
            <div key={s.key} className="flex items-center justify-between gap-4 text-slate-600">
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-sm" style={{ background: s.color }} />
                {CLASS_LABEL[s.key]}
              </span>
              <span className="tabular-nums text-slate-900">{rows[hover].values[k]}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
