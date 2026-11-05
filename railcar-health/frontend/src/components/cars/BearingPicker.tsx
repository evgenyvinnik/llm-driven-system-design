/**
 * Top-down car diagram. Axle 1 is at the B-end; standing at the B-end facing
 * the A-end, R is on your right. Each bearing is shaded by how far it ran above
 * its train-side median on the car's latest trip.
 */
import { heatColor } from '@/lib/heat'
import type { CarDetail } from '@/types'

interface Props {
  bearings: CarDetail['bearings']
  selected: string
  alerted: Set<string>
  onSelect: (position: string) => void
}

export function BearingPicker({ bearings, selected, alerted, onSelect }: Props) {
  const delta = (pos: string) => bearings.find((b) => b.position === pos)?.lastSideDelta ?? null
  const x = (axle: number) => 70 + (axle - 1) * 70
  return (
    <svg width={360} height={150} role="group" aria-label="Choose a bearing">
      <rect x={40} y={35} width={280} height={80} rx={6} fill="#f8fafc" stroke="#94a3b8" />
      <text x={20} y={80} fontSize={12} fontWeight={600} fill="#334155" textAnchor="middle">B</text>
      <text x={340} y={80} fontSize={12} fontWeight={600} fill="#334155" textAnchor="middle">A</text>
      <text x={180} y={24} fontSize={11} fill="#64748b" textAnchor="middle">L side</text>
      <text x={180} y={140} fontSize={11} fill="#64748b" textAnchor="middle">R side (facing A from B)</text>
      {[1, 2, 3, 4].map((axle) => (
        <g key={axle}>
          <line x1={x(axle)} x2={x(axle)} y1={52} y2={98} stroke="#cbd5e1" strokeWidth={3} />
          {(['L', 'R'] as const).map((side) => {
            const pos = `${side}${axle}`
            const d = delta(pos)
            const cy = side === 'L' ? 52 : 98
            const isSel = pos === selected
            return (
              <g key={pos} onClick={() => onSelect(pos)} className="cursor-pointer" role="button" aria-label={`Bearing ${pos}`} aria-pressed={isSel}>
                <circle cx={x(axle)} cy={cy} r={15} fill={heatColor(d, -10, 90)} stroke={isSel ? '#0f172a' : alerted.has(pos) ? '#d03b3b' : '#94a3b8'} strokeWidth={isSel ? 3 : alerted.has(pos) ? 2.5 : 1} />
                <text x={x(axle)} y={cy + 4} fontSize={11} fontWeight={600} textAnchor="middle" fill={d !== null && d > 50 ? '#fff' : '#0f172a'}>{pos}</text>
              </g>
            )
          })}
        </g>
      ))}
    </svg>
  )
}
