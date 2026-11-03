/**
 * The main time series. Columns for counts, a line for rates and percentiles.
 * It draws four things a plain chart would get wrong:
 *   - buckets after the watermark are hatched and labelled partial
 *   - the open bucket's comparison is "previous period up to the same time"
 *   - buckets before a metric was collected (or backfilled) are a labelled band, not zeros
 *   - buckets with late arrivals carry a "revised" mark
 * Clicking a bucket opens its drill-down.
 */
import { useState } from 'react'
import type { MetricInfo, SeriesBucket } from '../../lib/api'
import type { Grain } from '../../lib/filters'
import { bucketLabel, formatAxis, formatValue, localTime } from '../../lib/format'
import { labelStride, niceTicks, useElementWidth } from './scale'
import { Swatch, Tooltip, TooltipRow } from './Tooltip'

interface Props {
  buckets: SeriesBucket[]
  metric: MetricInfo
  grain: Grain
  timeZone: string
  watermark: string | null
  compareLabel: string | null
  selected?: string
  onSelect?: (bucket: SeriesBucket) => void
}

const H = 240
const M = { top: 16, right: 12, bottom: 34, left: 48 }

export function TrendChart({ buckets, metric, grain, timeZone, watermark, compareLabel, selected, onSelect }: Props) {
  const [ref, width] = useElementWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const asColumns = metric.kind === 'sum' || metric.kind === 'distinct'
  const innerW = Math.max(width - M.left - M.right, 10)
  const innerH = H - M.top - M.bottom
  const band = innerW / Math.max(buckets.length, 1)
  const barW = Math.min(24, band * 0.7)
  const values = buckets.flatMap((b) => [b.value ?? 0, b.previous?.value ?? 0, b.previous?.toDate ?? 0])
  const ticks = niceTicks(Math.max(...values, 0))
  const yMax = ticks[ticks.length - 1] || 1
  const y = (v: number) => M.top + innerH - (v / yMax) * innerH
  const cx = (i: number) => M.left + band * i + band / 2
  const stride = labelStride(buckets.length, innerW, grain === 'day' ? 52 : 44)
  const wm = watermark ? Date.parse(watermark) : null
  const t0 = buckets.length ? Date.parse(buckets[0].start) : 0
  const xOfTime = (t: number) => {
    const i = buckets.findIndex((b) => t >= Date.parse(b.start) && t < Date.parse(b.end))
    if (i < 0) return null
    const b = buckets[i]
    const f = (t - Date.parse(b.start)) / (Date.parse(b.end) - Date.parse(b.start))
    return M.left + band * (i + f)
  }
  const wmX = wm !== null && wm > t0 ? xOfTime(wm) : null
  const line = (pts: [number, number][]) => pts.map(([px, py], i) => `${i === 0 ? 'M' : 'L'}${px.toFixed(1)},${py.toFixed(1)}`).join(' ')

  // Contiguous runs of non-null points, so gaps (suppressed, not collected) break the line instead of dropping to zero.
  const runs = (get: (b: SeriesBucket) => number | null | undefined) => {
    const out: [number, number][][] = []
    let cur: [number, number][] = []
    buckets.forEach((b, i) => {
      const v = get(b)
      if (v === null || v === undefined) {
        if (cur.length) out.push(cur)
        cur = []
      } else cur.push([cx(i), y(v)])
    })
    if (cur.length) out.push(cur)
    return out
  }

  const hovered = hover !== null ? buckets[hover] : null

  return (
    <div ref={ref} className="relative w-full">
      {compareLabel && (
        <div className="mb-1 flex items-center gap-4 text-xs text-ink-2" aria-hidden>
          <span className="flex items-center gap-1.5">
            <Swatch color="var(--series-1)" line={!asColumns} /> This period
          </span>
          <span className="flex items-center gap-1.5">
            <Swatch color="var(--comparison)" line /> {compareLabel}
          </span>
        </div>
      )}
      {width > 0 && (
        <svg width={width} height={H} role="img" aria-label={`${metric.label} by ${grain}`} onMouseLeave={() => setHover(null)}>
          <defs>
            <pattern id="hatch-partial" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="6" height="6" fill="var(--series-1-wash)" />
              <line x1="0" y1="0" x2="0" y2="6" stroke="var(--series-1)" strokeWidth="2" />
            </pattern>
            <pattern id="hatch-gap" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(135)">
              <line x1="0" y1="0" x2="0" y2="6" stroke="var(--gridline)" strokeWidth="2" />
            </pattern>
          </defs>

          {ticks.map((t) => (
            <g key={t}>
              <line x1={M.left} x2={M.left + innerW} y1={y(t)} y2={y(t)} stroke="var(--gridline)" strokeWidth={1} />
              <text x={M.left - 6} y={y(t)} dy="0.32em" textAnchor="end" className="tabular fill-[var(--text-muted)] text-[11px]">
                {formatAxis(t, metric.unit)}
              </text>
            </g>
          ))}

          {/* Coverage and suppression bands */}
          {buckets.map((b, i) =>
            b.coverage !== 'ok' || b.suppressed ? (
              <rect key={`gap-${b.key}`} x={M.left + band * i} y={M.top} width={band} height={innerH} fill="url(#hatch-gap)" />
            ) : null,
          )}
          <GapLabels buckets={buckets} band={band} left={M.left} top={M.top + 30} />

          {/* After the watermark: still filling in */}
          {wmX !== null && wmX < M.left + innerW && (
            <rect x={wmX} y={M.top} width={M.left + innerW - wmX} height={innerH} fill="var(--series-1-wash)" opacity={0.6} />
          )}

          {asColumns &&
            buckets.map((b, i) => {
              if (b.value === null) return null
              const h = Math.max(innerH - (y(b.value) - M.top), b.value > 0 ? 1 : 0)
              const dim = selected && selected !== b.start
              return (
                <path
                  key={b.key}
                  d={roundedTop(cx(i) - barW / 2, y(b.value), barW, h, 4)}
                  fill={b.partial ? 'url(#hatch-partial)' : 'var(--series-1)'}
                  opacity={dim ? 0.35 : 1}
                />
              )
            })}

          {/* Previous period: a muted line, the open bucket compared to-date */}
          {compareLabel &&
            runs((b) => (b.open && b.previous?.toDate != null ? b.previous.toDate : b.previous?.value)).map((pts, k) => (
              <path key={`prev-${k}`} d={line(pts)} fill="none" stroke="var(--comparison)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            ))}

          {!asColumns &&
            runs((b) => b.value).map((pts, k) => (
              <path key={`cur-${k}`} d={line(pts)} fill="none" stroke="var(--series-1)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            ))}
          {!asColumns &&
            buckets.map((b, i) =>
              b.value === null ? null : (
                <circle
                  key={`pt-${b.key}`}
                  cx={cx(i)}
                  cy={y(b.value)}
                  r={4}
                  fill={b.partial ? 'var(--surface-1)' : 'var(--series-1)'}
                  stroke={b.partial ? 'var(--series-1)' : 'var(--surface-1)'}
                  strokeWidth={2}
                  opacity={selected && selected !== b.start ? 0.35 : 1}
                />
              ),
            )}

          {wmX !== null && wmX <= M.left + innerW && (
            <g>
              <line x1={wmX} x2={wmX} y1={M.top - 4} y2={M.top + innerH} stroke="var(--text-secondary)" strokeWidth={1} />
              <text x={wmX - 4} y={M.top + 6} textAnchor="end" className="fill-[var(--text-secondary)] text-[10px]">
                complete through {localTime(watermark, timeZone, grain === 'day' ? 'MMM d HH:mm' : 'HH:mm')}
              </text>
            </g>
          )}

          <line x1={M.left} x2={M.left + innerW} y1={M.top + innerH} y2={M.top + innerH} stroke="var(--baseline)" strokeWidth={1} />
          {buckets.map((b, i) => (
            <g key={`x-${b.key}`}>
              {i % stride === 0 && (
                <text x={cx(i)} y={M.top + innerH + 14} textAnchor="middle" className="tabular fill-[var(--text-muted)] text-[11px]">
                  {bucketLabel(b.start, grain, timeZone, true)}
                </text>
              )}
              {b.lateEvents > 0 && (
                <text x={cx(i)} y={M.top + innerH + 27} textAnchor="middle" className="fill-[var(--text-secondary)] text-[10px]">
                  ↻
                </text>
              )}
            </g>
          ))}

          {/* Hit targets: the whole bucket column, bigger than any mark */}
          {buckets.map((b, i) => (
            <rect
              key={`hit-${b.key}`}
              x={M.left + band * i}
              y={M.top}
              width={band}
              height={innerH}
              fill="transparent"
              style={{ cursor: onSelect && b.count > 0 ? 'pointer' : 'default' }}
              onMouseEnter={() => setHover(i)}
              onClick={() => onSelect && b.count > 0 && onSelect(b)}
              data-bucket={b.start}
            />
          ))}
          {hover !== null && <line x1={cx(hover)} x2={cx(hover)} y1={M.top} y2={M.top + innerH} stroke="var(--baseline)" strokeWidth={1} pointerEvents="none" />}
        </svg>
      )}
      {hovered && hover !== null && (
        <Tooltip x={cx(hover)} y={M.top + (compareLabel ? 20 : 0)} width={width}>
          <p className="mb-1 font-medium text-ink">
            {bucketLabel(hovered.start, grain, timeZone)}
            {hovered.clipped && <span className="font-normal text-ink-2"> – {localTime(hovered.end, timeZone, 'HH:mm')} (part of a UTC hour)</span>}
          </p>
          <TooltipRow swatch={<Swatch color="var(--series-1)" />} label={metric.label} value={bucketValueText(hovered, metric)} />
          {compareLabel && hovered.previous && (
            <TooltipRow
              swatch={<Swatch color="var(--comparison)" line />}
              label={hovered.open && hovered.previous.toDate != null ? `${compareLabel} (same time)` : compareLabel}
              value={formatValue(hovered.open && hovered.previous.toDate != null ? hovered.previous.toDate : hovered.previous.value, metric.unit)}
            />
          )}
          {hovered.partial && <p className="mt-1 text-ink-2">Partial: events after the watermark may still arrive.</p>}
          {hovered.previous?.clamped && <p className="mt-1 text-ink-2">Month-end clamped: shares its comparison day.</p>}
          {hovered.lateEvents > 0 && (
            <p className="mt-1 text-ink-2">
              ↻ {hovered.lateEvents} late event{hovered.lateEvents === 1 ? '' : 's'}
              {hovered.revisedAt ? `, revised ${localTime(hovered.revisedAt, timeZone, 'MMM d HH:mm')}` : ''}
            </p>
          )}
          {onSelect && hovered.count > 0 && <p className="mt-1 text-ink-muted">Click to list the {metric.drill.counts === 'users' ? 'users' : 'conversations'} behind it</p>}
        </Tooltip>
      )}
      <details className="mt-1 text-xs text-ink-2">
        <summary className="cursor-pointer select-none">View as table</summary>
        <table className="mt-2 w-full text-left">
          <thead className="text-ink-muted">
            <tr>
              <th className="py-1 font-medium">Bucket</th>
              <th className="py-1 text-right font-medium">Value</th>
              {compareLabel && <th className="py-1 text-right font-medium">{compareLabel}</th>}
              <th className="py-1 text-right font-medium">State</th>
            </tr>
          </thead>
          <tbody className="tabular">
            {buckets.map((b) => (
              <tr key={b.key} className="border-t" style={{ borderColor: 'var(--gridline)' }}>
                <td className="py-1">{bucketLabel(b.start, grain, timeZone)}</td>
                <td className="py-1 text-right">{bucketValueText(b, metric)}</td>
                {compareLabel && <td className="py-1 text-right">{formatValue(b.previous?.value, metric.unit)}</td>}
                <td className="py-1 text-right">{[b.partial && 'partial', b.lateEvents > 0 && `${b.lateEvents} late`].filter(Boolean).join(', ') || 'complete'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  )
}

function bucketValueText(b: SeriesBucket, metric: MetricInfo): string {
  if (b.suppressed) return 'hidden (< 5 users)'
  if (b.coverage === 'not_collected') return 'not collected'
  if (b.coverage === 'backfill_pending') return 'backfill pending'
  return `${metric.approximate ? '≈ ' : ''}${formatValue(b.value, metric.unit)}`
}

/** One label per contiguous run of gap buckets, centred, only when it fits. */
function GapLabels({ buckets, band, left, top }: { buckets: SeriesBucket[]; band: number; left: number; top: number }) {
  const labels: { x: number; w: number; text: string }[] = []
  let i = 0
  while (i < buckets.length) {
    const kind = buckets[i].suppressed ? 'suppressed' : buckets[i].coverage
    if (kind === 'ok') {
      i++
      continue
    }
    let j = i
    while (j + 1 < buckets.length && (buckets[j + 1].suppressed ? 'suppressed' : buckets[j + 1].coverage) === kind) j++
    const text = kind === 'not_collected' ? 'not collected' : kind === 'backfill_pending' ? 'backfill pending' : '< 5 users'
    labels.push({ x: left + band * i, w: band * (j - i + 1), text })
    i = j + 1
  }
  return (
    <>
      {labels
        .filter((l) => l.w >= l.text.length * 6 + 8)
        .map((l) => (
          <text key={l.x} x={l.x + l.w / 2} y={top} textAnchor="middle" className="fill-[var(--text-secondary)] text-[11px] font-medium">
            {l.text}
          </text>
        ))}
    </>
  )
}

/** Column with a 4px rounded data end, square at the baseline. */
function roundedTop(x: number, y: number, w: number, h: number, r: number): string {
  if (h <= 0) return ''
  const rr = Math.min(r, w / 2, h)
  return `M${x},${y + h} L${x},${y + rr} Q${x},${y} ${x + rr},${y} L${x + w - rr},${y} Q${x + w},${y} ${x + w},${y + rr} L${x + w},${y + h} Z`
}
