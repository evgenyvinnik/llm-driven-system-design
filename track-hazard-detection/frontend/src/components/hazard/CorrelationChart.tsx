import type { Evidence, Hazard } from '@/types'

const COLOR: Record<string, string> = { fence_break: '#b91c1c', ground_vibration: '#7c3aed', camera_obstruction: '#0369a1', high_water: '#0891b2' }
const W = 520
const H = 220
const P = { l: 52, r: 12, t: 14, b: 32 }

/**
 * Space-time view of the correlation: x is event time relative to the first
 * evidence, y is milepost. The shaded box is the correlation window
 * (+-30 s, +-0.5 mi) around the first evidence. Hollow points were near but
 * did not join (explained by a train, or a different hazard).
 */
export function CorrelationChart({ hazard, evidence, nearby, window }: { hazard: Hazard; evidence: Evidence[]; nearby: Evidence[]; window: { seconds: number; radiusMiles: number } }) {
  const all = [...evidence, ...nearby]
  if (all.length === 0) return <p className="text-sm text-slate-500">No sensor evidence (rail temperature trends are shown in the header).</p>
  const t0 = Date.parse(hazard.firstEvidenceAt)
  const secs = all.map((e) => (Date.parse(e.occurredAt) - t0) / 1000)
  const xMin = Math.min(-window.seconds, ...secs) - 5
  const xMax = Math.max(window.seconds, ...secs) + 5
  const mps = all.map((e) => e.milepost)
  const yMin = Math.min(hazard.mpFrom - window.radiusMiles, ...mps) - 0.2
  const yMax = Math.max(hazard.mpTo + window.radiusMiles, ...mps) + 0.2
  const x = (s: number) => P.l + ((s - xMin) / (xMax - xMin)) * (W - P.l - P.r)
  const y = (mp: number) => P.t + ((yMax - mp) / (yMax - yMin)) * (H - P.t - P.b)
  const first = evidence.find((e) => Date.parse(e.occurredAt) === t0) ?? evidence[0]
  const box = first && { x1: x(-window.seconds), x2: x(window.seconds), y1: y(first.milepost + window.radiusMiles), y2: y(first.milepost - window.radiusMiles) }
  const xTicks = Array.from({ length: 7 }, (_, i) => xMin + ((xMax - xMin) * i) / 6)
  const yTicks = Array.from({ length: 5 }, (_, i) => yMin + ((yMax - yMin) * i) / 4)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Correlation window">
      {box && <rect x={box.x1} y={box.y1} width={box.x2 - box.x1} height={box.y2 - box.y1} fill="#fde68a" opacity={0.35} stroke="#d97706" strokeDasharray="4 3" />}
      {box && <text x={box.x1 + 4} y={box.y1 + 11} className="fill-amber-700 text-[9px]">±{window.seconds}s · ±{window.radiusMiles} mi</text>}
      <line x1={P.l} x2={W - P.r} y1={H - P.b} y2={H - P.b} stroke="#94a3b8" />
      <line x1={P.l} x2={P.l} y1={P.t} y2={H - P.b} stroke="#94a3b8" />
      {xTicks.map((s) => (
        <text key={s} x={x(s)} y={H - P.b + 12} textAnchor="middle" className="fill-slate-500 text-[9px]">{`${s >= 0 ? '+' : ''}${Math.round(s)}s`}</text>
      ))}
      {yTicks.map((mp) => (
        <text key={mp} x={P.l - 5} y={y(mp) + 3} textAnchor="end" className="fill-slate-500 text-[9px]">{mp.toFixed(1)}</text>
      ))}
      <text x={(W + P.l) / 2} y={H - 4} textAnchor="middle" className="fill-slate-400 text-[9px]">event time relative to first evidence</text>
      {all.map((e) => {
        const joined = e.hazardId === hazard.hazardId
        const cx = x((Date.parse(e.occurredAt) - t0) / 1000)
        const cy = y(e.milepost)
        const c = COLOR[e.kind] ?? '#475569'
        return (
          <g key={e.eventId}>
            <title>{`${e.sensorId} ${e.kind} conf ${e.confidence}${e.late ? ' · late' : ''}${e.explainedByTrain ? ` · explained by ${e.explainedByTrain}` : ''}`}</title>
            <circle cx={cx} cy={cy} r={joined ? 5 : 4} fill={joined ? c : '#fff'} stroke={e.explainedByTrain ? '#94a3b8' : c} strokeWidth={1.6} />
            {e.late && <circle cx={cx} cy={cy} r={8} fill="none" stroke="#7e22ce" strokeDasharray="2 2" />}
            <text x={cx + 7} y={cy + 3} className="fill-slate-600 text-[8px]">{e.sensorId}</text>
          </g>
        )
      })}
    </svg>
  )
}
