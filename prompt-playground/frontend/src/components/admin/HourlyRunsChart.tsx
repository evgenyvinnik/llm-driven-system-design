import { useMemo, useState } from 'react'
import { AlertIcon } from '@/components/icons'
import type { AdminOverview } from '@/types'

/**
 * Runs per hour for the last 24 hours, stacked: failed on top of the rest.
 * Colors (validated with the dataviz palette check): series blue for the
 * bulk, the reserved "critical" status red for failures, which always appears
 * with an icon and label in the legend.
 */
const OK = '#2a78d6'
const FAILED = '#d03b3b'
const W = 640
const H = 200
const PAD = { top: 12, right: 8, bottom: 22, left: 32 }
const GAP = 2

interface Slot {
  hour: Date
  runs: number
  failed: number
}

function buildSlots(hourly: AdminOverview['hourly']): Slot[] {
  const byHour = new Map(hourly.map((h) => [new Date(h.hour).getTime(), h]))
  const now = new Date()
  now.setMinutes(0, 0, 0)
  return Array.from({ length: 24 }, (_, i) => {
    const hour = new Date(now.getTime() - (23 - i) * 3_600_000)
    const row = byHour.get(hour.getTime())
    return { hour, runs: row?.runs ?? 0, failed: row?.failed ?? 0 }
  })
}

function niceMax(value: number): number {
  if (value <= 4) return 4
  const magnitude = 10 ** Math.floor(Math.log10(value))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => value / s <= 4) ?? 10 * magnitude
  return Math.ceil(value / step) * step
}

/** Column path with a 4px rounded top (the data end) and a square base. */
function column(x: number, y: number, w: number, h: number, roundTop: boolean): string {
  const r = roundTop ? Math.min(4, h / 2, w / 2) : 0
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`
}

export function HourlyRunsChart({ hourly }: { hourly: AdminOverview['hourly'] }) {
  const slots = useMemo(() => buildSlots(hourly), [hourly])
  const [hovered, setHovered] = useState<number | null>(null)
  const [asTable, setAsTable] = useState(false)
  const max = niceMax(Math.max(1, ...slots.map((s) => s.runs)))
  const plotW = W - PAD.left - PAD.right
  const plotH = H - PAD.top - PAD.bottom
  const slotW = plotW / slots.length
  const barW = Math.min(18, slotW * 0.62)
  const y = (v: number) => PAD.top + plotH - (v / max) * plotH
  const ticks = [0, max / 2, max]
  const hour = (d: Date) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

  return (
    <div className="card p-4">
      <div className="mb-2 flex items-center gap-4">
        <span className="panel-title">Runs per hour · last 24h</span>
        <span className="flex items-center gap-1.5 text-xs text-slate-600">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: OK }} /> Completed or cancelled
        </span>
        <span className="flex items-center gap-1.5 text-xs text-slate-600">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: FAILED }} />
          <AlertIcon className="h-3 w-3 text-slate-500" /> Failed
        </span>
        <button className="ml-auto text-xs font-medium text-accent-700 hover:underline" onClick={() => setAsTable(!asTable)}>
          {asTable ? 'Show chart' : 'Show table'}
        </button>
      </div>
      {asTable ? (
        <div className="max-h-52 overflow-y-auto">
          <table className="w-full text-xs tabular-nums">
            <thead className="text-left text-slate-500">
              <tr>
                <th className="py-1 font-medium">Hour</th>
                <th className="py-1 text-right font-medium">Runs</th>
                <th className="py-1 text-right font-medium">Failed</th>
              </tr>
            </thead>
            <tbody>
              {slots.map((s) => (
                <tr key={s.hour.getTime()} className="border-t border-slate-100 text-slate-700">
                  <td className="py-1">{hour(s.hour)}</td>
                  <td className="py-1 text-right">{s.runs}</td>
                  <td className="py-1 text-right">{s.failed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="relative">
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Runs per hour over the last 24 hours">
            {ticks.map((t) => (
              <g key={t}>
                <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} stroke={t === 0 ? '#c3c2b7' : '#e1e0d9'} strokeWidth={1} />
                <text x={PAD.left - 6} y={y(t) + 3} textAnchor="end" fontSize={10} fill="#898781" className="tabular-nums">
                  {t}
                </text>
              </g>
            ))}
            {slots.map((s, i) => {
              const x = PAD.left + i * slotW + (slotW - barW) / 2
              const ok = s.runs - s.failed
              const okTop = y(ok)
              const failTop = y(s.runs)
              return (
                <g key={s.hour.getTime()} opacity={hovered === null || hovered === i ? 1 : 0.55}>
                  {ok > 0 && <path d={column(x, okTop, barW, y(0) - okTop, s.failed === 0)} fill={OK} />}
                  {s.failed > 0 && (
                    <path d={column(x, failTop, barW, Math.max(1, okTop - failTop - (ok > 0 ? GAP : 0)), true)} fill={FAILED} />
                  )}
                  {i % 6 === 0 && (
                    <text x={x + barW / 2} y={H - 6} textAnchor="middle" fontSize={10} fill="#898781">
                      {hour(s.hour)}
                    </text>
                  )}
                  <rect
                    x={PAD.left + i * slotW}
                    y={PAD.top}
                    width={slotW}
                    height={plotH}
                    fill="transparent"
                    tabIndex={0}
                    aria-label={`${hour(s.hour)}: ${s.runs} runs, ${s.failed} failed`}
                    onMouseEnter={() => setHovered(i)}
                    onMouseLeave={() => setHovered(null)}
                    onFocus={() => setHovered(i)}
                    onBlur={() => setHovered(null)}
                  />
                </g>
              )
            })}
          </svg>
          {hovered !== null && (
            <div
              className="pointer-events-none absolute top-0 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs shadow-md"
              style={{ left: `${((PAD.left + (hovered + 0.5) * slotW) / W) * 100}%`, transform: 'translateX(-50%)' }}
            >
              <div className="text-slate-500">{hour(slots[hovered].hour)}</div>
              <div className="flex items-center gap-1.5">
                <span className="inline-block h-0.5 w-3" style={{ background: OK }} />
                <strong className="tabular-nums text-slate-900">{slots[hovered].runs - slots[hovered].failed}</strong>
                <span className="text-slate-500">completed or cancelled</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="inline-block h-0.5 w-3" style={{ background: FAILED }} />
                <strong className="tabular-nums text-slate-900">{slots[hovered].failed}</strong>
                <span className="text-slate-500">failed</span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
