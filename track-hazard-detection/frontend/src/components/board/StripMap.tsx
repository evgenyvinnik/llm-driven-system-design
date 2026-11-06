import type { Board, Subdivision } from '@/types'
import { H, PAD, PAD_R, ROW, SENSOR_ROW, W, scaleFor } from './geometry'
import { HazardMarker, SensorGlyph, TrainMarker } from './StripLayers'

interface Props {
  subdivision: Subdivision
  board: Board
  onSelect: (hazardId: string) => void
}

const SENSOR_LABELS: Record<string, string> = { geophone: 'geophone', slide_fence: 'slide fence', camera: 'camera', rail_temp: 'rail temp', water_level: 'water' }

/** One subdivision as a horizontal strip: segments and coverage, hazards, slow orders, the track with trains, and sensors by type. */
export function StripMap({ subdivision: sub, board, onSelect }: Props) {
  const x = scaleFor(sub.startMp, sub.endMp)
  const segments = board.segments.filter((s) => s.subdivisionId === sub.id)
  const hazards = board.hazards.filter((h) => h.subdivisionId === sub.id)
  const warned = new Set(hazards.filter((h) => h.open).flatMap((h) => h.warnedTrains.filter((t) => !t.releasedAt).map((t) => t.trainId)))
  const sensorGaps = board.coverage.filter((c) => c.scope === 'sensor' && c.subdivisionId === sub.id)
  const ticks: number[] = []
  for (let mp = sub.startMp; mp <= sub.endMp; mp += 5) ticks.push(mp)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`${sub.name} strip map`}>
      <defs>
        <pattern id={`hatch-${sub.id}`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="6" stroke="#dc2626" strokeWidth="2" opacity="0.35" />
        </pattern>
      </defs>
      {segments.map((s) => {
        const offline = s.gatewayCoverage === 'degraded'
        return (
          <g key={s.id}>
            <title>{`${s.id} · ${s.gatewayId} · ${offline ? 'GATEWAY SILENT: coverage degraded' : 'gateway OK'}${s.watermarkLagSeconds !== null ? ` · data complete to ${Math.round(s.watermarkLagSeconds)}s ago` : ''}`}</title>
            {offline && <rect x={x(s.startMp)} y={ROW.segment + 6} width={x(s.endMp) - x(s.startMp)} height={H - ROW.segment - 8} fill={`url(#hatch-${sub.id})`} />}
            <line x1={x(s.startMp)} x2={x(s.startMp)} y1={ROW.segment - 6} y2={H - 4} stroke="#cbd5e1" strokeDasharray="2 3" />
            <text x={(x(s.startMp) + x(s.endMp)) / 2} y={ROW.segment} textAnchor="middle" className={`text-[9px] ${offline ? 'fill-red-600 font-semibold' : 'fill-slate-400'}`}>
              {s.id}
              {offline ? ' · GW SILENT' : ''}
            </text>
          </g>
        )
      })}
      {sensorGaps.map((c) => (
        <rect key={c.key} x={x(c.mpFrom)} y={ROW.sensors - 6} width={Math.max(3, x(c.mpTo) - x(c.mpFrom))} height={52} fill={`url(#hatch-${sub.id})`}>
          <title>{`${c.targetId}: no heartbeat since ${new Date(c.since).toLocaleTimeString()}; coverage degraded MP ${c.mpFrom}-${c.mpTo}`}</title>
        </rect>
      ))}
      {board.restrictions
        .filter((r) => r.subdivisionId === sub.id)
        .map((r) => (
          <g key={r.restrictionId}>
            <title>{`${r.restrictionId} · ${r.maxSpeedMph} mph · MP ${r.mpFrom}-${r.mpTo} · ${r.reason}`}</title>
            <rect x={x(r.mpFrom)} y={ROW.restriction - 4} width={Math.max(6, x(r.mpTo) - x(r.mpFrom))} height={8} rx={2} fill="#facc15" stroke="#a16207" strokeWidth={0.6} />
            <text x={x(r.mpFrom) + 2} y={ROW.restriction + 2.5} className="fill-yellow-900 text-[7px] font-bold">
              {r.maxSpeedMph}
            </text>
          </g>
        ))}
      <line x1={PAD} x2={W - PAD_R} y1={ROW.track} y2={ROW.track} stroke="#334155" strokeWidth={3} />
      {ticks.map((mp) => (
        <g key={mp}>
          <line x1={x(mp)} x2={x(mp)} y1={ROW.track - 3} y2={ROW.track + 3} stroke="#334155" />
          {mp % 10 === 0 && (
            <text x={x(mp)} y={ROW.mp} textAnchor="middle" className="fill-slate-500 text-[9px]">
              {mp}
            </text>
          )}
        </g>
      ))}
      {Object.entries(SENSOR_ROW).map(([type, row]) => (
        <text key={type} x={PAD - 8} y={ROW.sensors + row * 10 + 3} textAnchor="end" className="fill-slate-400 text-[8px]">
          {SENSOR_LABELS[type]}
        </text>
      ))}
      {board.sensors
        .filter((s) => s.subdivisionId === sub.id)
        .map((s) => (
          <SensorGlyph key={s.id} sensor={s} x={x(s.milepost)} />
        ))}
      {board.trains
        .filter((t) => t.subdivisionId === sub.id)
        .map((t) => (
          <TrainMarker key={t.trainId} train={t} x={x(t.milepost)} warned={warned.has(t.trainId)} />
        ))}
      {[...hazards]
        .sort((a, b) => Number(a.open) - Number(b.open))
        .map((h) => (
          <HazardMarker key={h.hazardId} hazard={h} x1={x(h.mpFrom)} x2={x(h.mpTo)} onSelect={onSelect} />
        ))}
    </svg>
  )
}
