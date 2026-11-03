/**
 * p50 / p95 / p99 lines. Each point is a merged t-digest for its bucket, so a
 * day's p95 is computed over the day's responses, never averaged from hours.
 */
import { useState } from 'react'
import type { LatencyResponse } from '../../lib/api'
import type { Grain } from '../../lib/filters'
import { bucketLabel, formatAxis, formatValue } from '../../lib/format'
import { labelStride, niceTicks, useElementWidth } from './scale'
import { Swatch, Tooltip, TooltipRow } from './Tooltip'

const SERIES = [
  { idx: 0, name: 'p50', color: 'var(--series-1)' },
  { idx: 1, name: 'p95', color: 'var(--series-2)' },
  { idx: 2, name: 'p99', color: 'var(--series-3)' },
] as const

const H = 210
const M = { top: 12, right: 36, bottom: 24, left: 48 }

export function LatencyChart({ data, field, grain, timeZone }: { data: LatencyResponse; field: 'ttft' | 'latency'; grain: Grain; timeZone: string }) {
  const [ref, width] = useElementWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const buckets = data.buckets
  const innerW = Math.max(width - M.left - M.right, 10)
  const innerH = H - M.top - M.bottom
  const band = innerW / Math.max(buckets.length, 1)
  const ticks = niceTicks(Math.max(...buckets.map((b) => b[field]?.[2] ?? 0), 0))
  const yMax = ticks[ticks.length - 1] || 1
  const y = (v: number) => M.top + innerH - (v / yMax) * innerH
  const cx = (i: number) => M.left + band * i + band / 2
  const stride = labelStride(buckets.length, innerW, 48)

  const paths = SERIES.map((s) => {
    let d = ''
    let pen = false
    buckets.forEach((b, i) => {
      const v = b[field]?.[s.idx]
      if (v == null) {
        pen = false
        return
      }
      d += `${pen ? 'L' : 'M'}${cx(i).toFixed(1)},${y(v).toFixed(1)} `
      pen = true
    })
    return d
  })
  const lastIdx = buckets.map((b) => b[field] !== null).lastIndexOf(true)
  // End labels that would overlap are dropped; the legend still names every line.
  const placed: number[] = []
  const showLabel = (v: number) => {
    const py = y(v)
    if (placed.some((p) => Math.abs(p - py) < 11)) return false
    placed.push(py)
    return true
  }

  return (
    <div ref={ref} className="relative w-full">
      <div className="mb-1 flex items-center gap-4 text-xs text-ink-2">
        {SERIES.map((s) => (
          <span key={s.name} className="flex items-center gap-1.5">
            <Swatch color={s.color} line /> {s.name}
          </span>
        ))}
      </div>
      {width > 0 && (
        <svg width={width} height={H} role="img" aria-label={`${field === 'ttft' ? 'Time to first token' : 'Total response time'} percentiles`} onMouseLeave={() => setHover(null)}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={M.left} x2={M.left + innerW} y1={y(t)} y2={y(t)} stroke="var(--gridline)" />
              <text x={M.left - 6} y={y(t)} dy="0.32em" textAnchor="end" className="tabular fill-[var(--text-muted)] text-[11px]">
                {formatAxis(t, 'ms')}
              </text>
            </g>
          ))}
          {paths.map((d, k) => (
            <path key={SERIES[k].name} d={d} fill="none" stroke={SERIES[k].color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {lastIdx >= 0 &&
            SERIES.map((s) => {
              const v = buckets[lastIdx][field]![s.idx]
              return (
                <g key={`end-${s.name}`}>
                  <circle cx={cx(lastIdx)} cy={y(v)} r={4} fill={s.color} stroke="var(--surface-1)" strokeWidth={2} />
                  {showLabel(v) && (
                    <text x={cx(lastIdx) + 8} y={y(v)} dy="0.32em" className="fill-[var(--text-secondary)] text-[10px]">
                      {s.name}
                    </text>
                  )}
                </g>
              )
            })}
          <line x1={M.left} x2={M.left + innerW} y1={M.top + innerH} y2={M.top + innerH} stroke="var(--baseline)" />
          {buckets.map((b, i) =>
            i % stride === 0 ? (
              <text key={b.key} x={cx(i)} y={M.top + innerH + 14} textAnchor="middle" className="tabular fill-[var(--text-muted)] text-[11px]">
                {bucketLabel(b.start, grain, timeZone, true)}
              </text>
            ) : null,
          )}
          {buckets.map((b, i) => (
            <rect key={`hit-${b.key}`} x={M.left + band * i} y={M.top} width={band} height={innerH} fill="transparent" onMouseEnter={() => setHover(i)} />
          ))}
          {hover !== null && <line x1={cx(hover)} x2={cx(hover)} y1={M.top} y2={M.top + innerH} stroke="var(--baseline)" pointerEvents="none" />}
        </svg>
      )}
      {hover !== null && buckets[hover] && (
        <Tooltip x={cx(hover)} y={M.top + 20} width={width}>
          <p className="mb-1 font-medium text-ink">{bucketLabel(buckets[hover].start, grain, timeZone)}</p>
          {buckets[hover].suppressed ? (
            <p className="text-ink-2">Hidden: fewer than 5 users</p>
          ) : (
            SERIES.map((s) => <TooltipRow key={s.name} swatch={<Swatch color={s.color} line />} label={s.name} value={`≈ ${formatValue(buckets[hover][field]?.[s.idx] ?? null, 'ms')}`} />)
          )}
          <TooltipRow label="Completed responses" value={buckets[hover].responses.toLocaleString()} />
          {buckets[hover].partial && <p className="mt-1 text-ink-2">Partial: more responses may still arrive.</p>}
        </Tooltip>
      )}
    </div>
  )
}
