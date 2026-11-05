/**
 * The line as a strip: subdivisions, yards, detectors coloured by health, and
 * coverage gaps (stretches longer than the configured spacing with no working
 * detector). Health is also written as text under each problem detector.
 */
import type { Network } from '@/types'

const W = 860
const X0 = 30
const X1 = W - 30
const STATUS_FILL: Record<string, string> = { ok: '#0ca30c', offline: '#7c3aed', silent: '#d03b3b', biased: '#fab219' }

export function StripMap({ network, selected, onSelect }: { network: Network; selected: string | null; onSelect: (id: string) => void }) {
  const sx = (mp: number) => X0 + (mp / 240) * (X1 - X0)
  return (
    <svg viewBox={`0 0 ${W} 150`} width="100%" style={{ maxWidth: W, minWidth: 640 }} role="img" aria-label="Detector coverage along the line">
      {network.subdivisions.map((s, i) => (
        <g key={s.id}>
          <rect x={sx(s.startMp)} y={14} width={sx(s.endMp) - sx(s.startMp)} height={100} fill={i % 2 ? '#f8fafc' : '#f1f5f9'} />
          <text x={sx(s.startMp) + 6} y={28} fontSize={11} fill="#64748b">{s.name} · {s.deskId} desk</text>
        </g>
      ))}
      {network.coverageGaps.map((g) => (
        <g key={g.fromMp}>
          <rect x={sx(g.fromMp)} y={58} width={sx(g.toMp) - sx(g.fromMp)} height={12} fill="#fee2e2" stroke="#d03b3b" strokeDasharray="3 2" />
          <text x={(sx(g.fromMp) + sx(g.toMp)) / 2} y={52} fontSize={10} fill="#b91c1c" textAnchor="middle" fontWeight={600}>coverage gap {g.miles} mi</text>
        </g>
      ))}
      <line x1={X0} x2={X1} y1={64} y2={64} stroke="#334155" strokeWidth={3} />
      {network.yards.map((y) => (
        <g key={y.id}>
          <rect x={sx(y.milepost) - 7} y={57} width={14} height={14} fill="#0f172a" />
          <text x={sx(y.milepost)} y={92} fontSize={10} textAnchor="middle" fill="#0f172a" fontWeight={600}>{y.id}</text>
        </g>
      ))}
      {network.detectors.map((d) => (
        <g key={d.id} onClick={() => onSelect(d.id)} className="cursor-pointer" role="button" aria-label={`${d.id} ${d.status}`}>
          <circle cx={sx(d.milepost)} cy={64} r={d.id === selected ? 8 : 6} fill={STATUS_FILL[d.status]} stroke="#fff" strokeWidth={2} />
          <text x={sx(d.milepost)} y={106} fontSize={9} textAnchor="middle" fill="#475569">{d.milepost}</text>
          {d.status !== 'ok' && <text x={sx(d.milepost)} y={124} fontSize={9} textAnchor="middle" fill="#334155" fontWeight={600}>{d.id} {d.status}</text>}
        </g>
      ))}
      <text x={X0} y={144} fontSize={10} fill="#64748b">MP 0</text>
      <text x={X1} y={144} fontSize={10} fill="#64748b" textAnchor="end">MP 240</text>
    </svg>
  )
}
