import { msText } from '@/lib/format'
import type { Latency } from '@/types'

const STAGES: Array<{ key: keyof Latency['stages']; label: string; color: string; hint: string }> = [
  { key: 'edgeToIngest', label: 'Edge → ingest', color: '#64748b', hint: 'gateway send + network; includes edge buffering when offline' },
  { key: 'ingestToDetect', label: 'Ingest → HazardDetected', color: '#7c3aed', hint: 'outbox relay + critical lane + correlator' },
  { key: 'detectToAlert', label: 'Detected → AlertIssued', color: '#d97706', hint: 'outbox relay + process manager' },
  { key: 'alertToDelivered', label: 'Issued → on console', color: '#0284c7', hint: 'outbox relay + notifier (simulated provider)' },
]

/** Median time spent in each hop of the alert path (live, not late, alerts). */
export function StageBars({ stages }: { stages: Latency['stages'] }) {
  const total = STAGES.reduce((s, st) => s + (stages[st.key].p50 ?? 0), 0) || 1
  return (
    <div className="space-y-3">
      <div className="flex h-6 overflow-hidden rounded-md" aria-label="Median stage breakdown">
        {STAGES.map((st) => (
          <div key={st.key} style={{ width: `${((stages[st.key].p50 ?? 0) / total) * 100}%`, background: st.color }} title={`${st.label}: ${msText(stages[st.key].p50)}`} />
        ))}
      </div>
      <table className="min-w-full text-sm">
        <thead>
          <tr>
            <th className="th pl-0">Stage</th>
            <th className="th">p50</th>
            <th className="th">p99</th>
            <th className="th">What it includes</th>
          </tr>
        </thead>
        <tbody>
          {STAGES.map((st) => (
            <tr key={st.key}>
              <td className="td whitespace-nowrap pl-0">
                <span className="mr-2 inline-block h-2.5 w-2.5 rounded-sm" style={{ background: st.color }} />
                {st.label}
              </td>
              <td className="td whitespace-nowrap">{msText(stages[st.key].p50)}</td>
              <td className="td whitespace-nowrap">{msText(stages[st.key].p99)}</td>
              <td className="td text-xs text-slate-500">{st.hint}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
