import { EVIDENCE_COLOR, EVIDENCE_LABEL } from '@/lib/format'
import type { EvidenceClass, EvidenceCounts } from '@/types'

const ORDER: EvidenceClass[] = ['safe_to_fix', 'needs_owner_migration', 'insufficient_evidence']

/** Open findings split by evidence class: one whole, three parts, 2px gaps between segments. */
export function EvidenceBar({ counts }: { counts: EvidenceCounts }) {
  const total = ORDER.reduce((n, k) => n + counts[k], 0)
  if (total === 0) return <span className="text-xs text-slate-400">none open</span>
  const summary = ORDER.map((k) => `${EVIDENCE_LABEL[k]}: ${counts[k]}`).join(', ')
  return (
    <div className="flex h-2.5 w-40 gap-[2px]" role="img" aria-label={summary} title={summary}>
      {ORDER.filter((k) => counts[k] > 0).map((k) => (
        <div key={k} className={`h-full rounded-[3px] ${EVIDENCE_COLOR[k]}`} style={{ width: `${(counts[k] / total) * 100}%` }} />
      ))}
    </div>
  )
}

export function EvidenceLegend() {
  return (
    <div className="flex flex-wrap gap-3 text-xs text-slate-600">
      {ORDER.map((k) => (
        <span key={k} className="inline-flex items-center gap-1.5">
          <span className={`h-2.5 w-2.5 rounded-[3px] ${EVIDENCE_COLOR[k]}`} aria-hidden /> {EVIDENCE_LABEL[k]}
        </span>
      ))}
    </div>
  )
}
