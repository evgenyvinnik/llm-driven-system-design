import type { Hazard, SensorView, Train } from '@/types'
import { KIND_LABEL, mpText } from '@/lib/format'
import { ROW, SENSOR_ROW, SEV_COLOR } from './geometry'

const HEAT_COLOR: Record<string, string> = { normal: '#94a3b8', watch: '#facc15', elevated: '#f97316', critical: '#dc2626' }

function heatBand(s: SensorView): string {
  const t = typeof s.lastValue?.tempF === 'number' ? s.lastValue.tempF : null
  if (t === null || s.neutralTempF === null) return 'normal'
  const d = t - s.neutralTempF
  return d >= 45 ? 'critical' : d >= 35 ? 'elevated' : d >= 25 ? 'watch' : 'normal'
}

export function SensorGlyph({ sensor, x }: { sensor: SensorView; x: number }) {
  const y = ROW.sensors + SENSOR_ROW[sensor.type] * 10
  const dead = sensor.coverage === 'degraded'
  const color = dead ? '#dc2626' : sensor.type === 'rail_temp' ? HEAT_COLOR[heatBand(sensor)] : '#475569'
  const value = sensor.lastValue
  const reading = sensor.type === 'rail_temp' && typeof value?.tempF === 'number' ? ` · ${value.tempF}°F (RNT ${sensor.neutralTempF}°F)` : sensor.type === 'water_level' && typeof value?.inchesBelowRail === 'number' ? ` · ${value.inchesBelowRail} in below rail` : ''
  const title = `${sensor.id}${sensor.label ? ` · ${sensor.label}` : ''}${reading}${dead ? ' · NO HEARTBEAT' : ''}`
  let shape
  if (sensor.type === 'geophone') shape = <circle cx={x} cy={y} r={2.6} fill={color} />
  else if (sensor.type === 'slide_fence') shape = <rect x={x - 2.6} y={y - 2.6} width={5.2} height={5.2} fill="none" stroke={color} strokeWidth={1.4} />
  else if (sensor.type === 'camera') shape = <path d={`M${x - 3} ${y + 2.5}L${x} ${y - 3}L${x + 3} ${y + 2.5}Z`} fill={color} />
  else if (sensor.type === 'rail_temp') shape = <circle cx={x} cy={y} r={3.2} fill={color} stroke="#fff" strokeWidth={0.8} />
  else shape = <path d={`M${x} ${y - 3.5}C${x + 3} ${y},${x + 2.6} ${y + 3},${x} ${y + 3}C${x - 2.6} ${y + 3},${x - 3} ${y},${x} ${y - 3.5}Z`} fill="#0284c7" />
  return (
    <g>
      <title>{title}</title>
      {shape}
      {dead && <path d={`M${x - 4} ${y - 4}L${x + 4} ${y + 4}M${x + 4} ${y - 4}L${x - 4} ${y + 4}`} stroke="#dc2626" strokeWidth={1.6} />}
    </g>
  )
}

export function HazardMarker({ hazard, x1, x2, onSelect }: { hazard: Hazard; x1: number; x2: number; onSelect: (id: string) => void }) {
  const color = hazard.open ? SEV_COLOR[hazard.severity] : '#94a3b8'
  const cx = (x1 + x2) / 2
  const y = ROW.hazard
  const heat = hazard.kind === 'rail_buckling_risk'
  return (
    <g className="cursor-pointer" onClick={() => onSelect(hazard.hazardId)} role="button" aria-label={`Hazard ${hazard.code}`}>
      <title>{`${hazard.code} · ${KIND_LABEL[hazard.kind]} · ${mpText(hazard.mpFrom, hazard.mpTo)} · ${hazard.severity} · ${hazard.open ? hazard.responseStatus : 'closed'}`}</title>
      {heat ? (
        <rect x={x1} y={y - 7} width={Math.max(4, x2 - x1)} height={14} rx={3} fill={color} opacity={hazard.open ? 0.28 : 0.12} stroke={color} strokeDasharray="3 2" />
      ) : (
        x2 - x1 > 3 && <rect x={x1} y={y - 2} width={x2 - x1} height={4} fill={color} opacity={0.5} />
      )}
      <path d={`M${cx} ${y - 8}L${cx + 7} ${y}L${cx} ${y + 8}L${cx - 7} ${y}Z`} fill={color} stroke="#fff" strokeWidth={1.2} opacity={hazard.open ? 1 : 0.6} />
      {hazard.open && hazard.severity === 'CRITICAL' && <circle cx={cx} cy={y} r={11} fill="none" stroke={color} strokeWidth={1.2} className="animate-ping origin-center" style={{ transformBox: 'fill-box' }} />}
      <text x={cx} y={y - 11} textAnchor="middle" className="fill-slate-700 text-[9px] font-semibold">
        {hazard.code}
      </text>
    </g>
  )
}

export function TrainMarker({ train, x, warned }: { train: Train; x: number; warned: boolean }) {
  const dir = train.direction === 'increasing' ? 1 : -1
  const y = ROW.track
  return (
    <g>
      <title>{`${train.symbol} · MP ${train.milepost.toFixed(1)} · ${train.speedMph} mph ${train.direction === 'increasing' ? 'increasing MP' : 'decreasing MP'}${warned ? ' · WARNED' : ''}`}</title>
      {warned && <circle cx={x} cy={y} r={9} fill="none" stroke="#d03b3b" strokeWidth={1.5} />}
      <path d={`M${x - 7 * dir} ${y - 5}L${x + 7 * dir} ${y}L${x - 7 * dir} ${y + 5}Z`} fill="#1d4ed8" stroke="#fff" strokeWidth={1} />
      <text x={x} y={ROW.trainLabel} textAnchor="middle" className="fill-blue-800 text-[9px] font-semibold">
        {train.symbol}
      </text>
    </g>
  )
}
