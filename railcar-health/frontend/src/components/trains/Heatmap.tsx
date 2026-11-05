/**
 * Axle-by-detector heatmap. Columns are car axles in train order, rows are
 * detector passes (two rails each). Colour = bearing temperature above ambient,
 * or relative to the median of the same rail in the same pass. Alerted bearings
 * are outlined across every detector so the trend reads top to bottom.
 */
import { useMemo, useState, type MouseEvent } from 'react'
import { HEAT_SCALE, heatColor, type HeatMode } from '@/lib/heat'
import { TIER_NAMES } from '@/lib/tiers'
import type { Heatmap as HeatmapData } from '@/types'

const LABEL_W = 168
const CELL_W = 3
const ROW_H = 9
const PASS_GAP = 5
const TOP = 26

export function Heatmap({ data, mode }: { data: HeatmapData; mode: HeatMode }) {
  const [hover, setHover] = useState<{ x: number; y: number; text: string[] } | null>(null)
  const cols = data.columns.length
  const width = LABEL_W + cols * CELL_W + 8
  const rowY = (passIdx: number, railIdx: number) => TOP + passIdx * (2 * ROW_H + PASS_GAP) + railIdx * ROW_H
  const height = rowY(data.passes.length, 0) + 4
  const [min, max] = HEAT_SCALE[mode]

  const cells = useMemo(() => {
    const out: Array<{ key: string; x: number; y: number; fill: string }> = []
    data.passes.forEach((p, pi) => {
      ;(['N', 'S'] as const).forEach((rail, ri) => {
        const base = mode === 'ambient' ? p.ambientF : (p.medians[rail] ?? p.ambientF)
        p.values[rail].forEach((v, ci) => out.push({ key: `${pi}${rail}${ci}`, x: LABEL_W + ci * CELL_W, y: rowY(pi, ri), fill: heatColor(v === null ? null : v - base, min, max) }))
      })
    })
    return out
  }, [data, mode, min, max])

  function onMove(e: MouseEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const ci = Math.floor((x - LABEL_W) / CELL_W)
    const pi = Math.floor((y - TOP) / (2 * ROW_H + PASS_GAP))
    const within = y - TOP - pi * (2 * ROW_H + PASS_GAP)
    if (ci < 0 || ci >= cols || pi < 0 || pi >= data.passes.length || within >= 2 * ROW_H) return setHover(null)
    const rail = within < ROW_H ? 'N' : 'S'
    const pass = data.passes[pi]
    const col = data.columns[ci]
    const v = pass.values[rail][ci]
    const median = pass.medians[rail]
    setHover({
      x, y,
      text: [
        `${col.carId} · car ${col.carIndex}, axle ${col.seqInCar} in train order`,
        `${pass.detectorId} (MP ${pass.milepost}) · ${rail} rail`,
        v === null ? 'no reading' : `${v}°F · ${Math.round(v - pass.ambientF)}°F above ambient · ${median === null ? '' : `${v - median >= 0 ? '+' : ''}${Math.round(v - median)}°F vs rail median`}`,
      ],
    })
  }

  return (
    <div className="relative overflow-x-auto">
      <svg width={width} height={height} role="img" aria-label="Bearing temperature heatmap by detector and axle" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        {Array.from({ length: Math.floor((data.columns.at(-1)?.carIndex ?? 0) / 10) }, (_, i) => (i + 1) * 10).map((carNo) => {
          const ci = data.columns.findIndex((c) => c.carIndex === carNo)
          return (
            <g key={carNo}>
              <line x1={LABEL_W + ci * CELL_W} x2={LABEL_W + ci * CELL_W} y1={TOP - 6} y2={TOP - 1} stroke="#94a3b8" />
              <text x={LABEL_W + ci * CELL_W} y={TOP - 9} fontSize={10} textAnchor="middle" fill="#64748b">car {carNo}</text>
            </g>
          )
        })}
        {data.passes.map((p, pi) => (
          <g key={p.passId}>
            <text x={0} y={rowY(pi, 0) + ROW_H + 3} fontSize={11} fill="#334155" fontFamily="ui-monospace, monospace">{p.detectorId}</text>
            <text x={62} y={rowY(pi, 0) + ROW_H + 3} fontSize={10} fill="#64748b">MP {p.milepost}</text>
            {p.late && <text x={104} y={rowY(pi, 0) + ROW_H + 3} fontSize={10} fill="#6d28d9" fontWeight={600}>late</text>}
            {p.biasOffsetF !== null && <text x={130} y={rowY(pi, 0) + ROW_H + 3} fontSize={10} fill="#b45309" fontWeight={600}>bias</text>}
          </g>
        ))}
        {cells.map((c) => <rect key={c.key} x={c.x} y={c.y} width={CELL_W} height={ROW_H} fill={c.fill} />)}
        {data.highlights.filter((h) => h.column >= 0).map((h) => {
          const x = LABEL_W + h.column * CELL_W
          return (
            <g key={h.alertId}>
              {data.passes.map((p, pi) =>
                (['N', 'S'] as const).filter((r) => h.rail === null || h.rail === r).map((r) => (
                  <rect key={`${p.passId}${r}`} x={x - 1} y={rowY(pi, r === 'N' ? 0 : 1)} width={h.span * CELL_W + 2} height={ROW_H} fill="none" stroke="#0f172a" strokeWidth={1.2} />
                )),
              )}
              <text x={x + 4} y={TOP - 18} fontSize={10} fontWeight={600} fill="#0f172a">▼ {h.kind === 'hot_wheel' ? 'wheels' : h.position} {TIER_NAMES[h.tier]}</text>
            </g>
          )
        })}
      </svg>
      {hover && (
        <div className="pointer-events-none absolute z-10 rounded-md bg-slate-900 px-2.5 py-1.5 text-xs text-white shadow-lg" style={{ left: Math.min(hover.x + 12, width - 280), top: hover.y + 12 }}>
          {hover.text.map((t) => <div key={t}>{t}</div>)}
        </div>
      )}
    </div>
  )
}
