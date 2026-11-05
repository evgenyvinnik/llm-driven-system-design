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
const ROW_H = 9
const PASS_GAP = 5
const GAP_EXTRA = 14
const TOP = 26
/** Gaps wider than this between consecutive passes are drawn (a silent or offline detector). */
const GAP_MILES = 20

export function Heatmap({ data, mode }: { data: HeatmapData; mode: HeatMode }) {
  const [hover, setHover] = useState<{ x: number; y: number; text: string[] } | null>(null)
  const cols = data.columns.length
  const CELL_W = Math.max(3, Math.min(6, Math.floor(1300 / Math.max(1, cols))))
  const width = LABEL_W + cols * CELL_W + 8
  // Row tops, with extra space where the train went a long way between readings.
  const tops = useMemo(() => {
    const out: number[] = []
    let y = TOP
    data.passes.forEach((p, i) => {
      if (i > 0 && Math.abs(p.milepost - data.passes[i - 1].milepost) > GAP_MILES) y += GAP_EXTRA
      out.push(y)
      y += 2 * ROW_H + PASS_GAP
    })
    out.push(y)
    return out
  }, [data])
  const rowY = (passIdx: number, railIdx: number) => tops[passIdx] + railIdx * ROW_H
  const height = tops[data.passes.length] + 4
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, mode, min, max, CELL_W, tops])

  function onMove(e: MouseEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const ci = Math.floor((x - LABEL_W) / CELL_W)
    const pi = tops.findIndex((t, i) => i < data.passes.length && y >= t && y < t + 2 * ROW_H)
    const within = pi < 0 ? 99 : y - tops[pi]
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
            {pi > 0 && Math.abs(p.milepost - data.passes[pi - 1].milepost) > GAP_MILES && (
              <g>
                <line x1={LABEL_W} x2={width - 8} y1={tops[pi] - GAP_EXTRA / 2 - 2} y2={tops[pi] - GAP_EXTRA / 2 - 2} stroke="#d03b3b" strokeDasharray="4 3" />
                <text x={0} y={tops[pi] - GAP_EXTRA / 2 + 1} fontSize={10} fill="#b91c1c" fontWeight={600}>
                  {Math.abs(p.milepost - data.passes[pi - 1].milepost)} mi with no reading
                </text>
              </g>
            )}
            <text x={0} y={rowY(pi, 0) + ROW_H + 3} fontSize={11} fill="#334155" fontFamily="ui-monospace, monospace">{p.detectorId}</text>
            <text x={62} y={rowY(pi, 0) + ROW_H + 3} fontSize={10} fill="#64748b">MP {p.milepost}</text>
            {p.late && <text x={104} y={rowY(pi, 0) + ROW_H + 3} fontSize={10} fill="#6d28d9" fontWeight={600}>late</text>}
            {p.biasOffsetF !== null && <text x={130} y={rowY(pi, 0) + ROW_H + 3} fontSize={10} fill="#b45309" fontWeight={600}>bias</text>}
          </g>
        ))}
        {cells.map((c) => <rect key={c.key} x={c.x} y={c.y} width={CELL_W} height={ROW_H} fill={c.fill} />)}
        {data.highlights.filter((h) => h.column >= 0).map((h) => {
          const x = LABEL_W + h.column * CELL_W
          const w = h.span * CELL_W
          // Rails either side of the alerted column, so the cell colours stay visible.
          return (
            <g key={h.alertId}>
              {data.passes.map((p, pi) =>
                (['N', 'S'] as const).filter((r) => h.rail === null || h.rail === r).map((r) => (
                  <g key={`${p.passId}${r}`}>
                    <line x1={x - 1.5} x2={x - 1.5} y1={rowY(pi, r === 'N' ? 0 : 1)} y2={rowY(pi, r === 'N' ? 0 : 1) + ROW_H} stroke="#0f172a" strokeWidth={1.5} />
                    <line x1={x + w + 1.5} x2={x + w + 1.5} y1={rowY(pi, r === 'N' ? 0 : 1)} y2={rowY(pi, r === 'N' ? 0 : 1) + ROW_H} stroke="#0f172a" strokeWidth={1.5} />
                  </g>
                )),
              )}
              <text x={x + w / 2} y={TOP - 18} fontSize={10} fontWeight={600} fill="#0f172a" textAnchor="middle">▼ {h.kind === 'hot_bearing' ? h.position : 'brakes'} {TIER_NAMES[h.tier]}</text>
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
