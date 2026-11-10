import { Sha } from '@/components/shared/Chips'
import { ago, humanize } from '@/lib/format'
import type { AuditEntry } from '@/types'

const EMPHASIS: Record<string, string> = {
  head_changed: 'border-accent-500 text-accent-700',
  decision_invalidated: 'border-amber-500 text-amber-800',
  approval_dismissed: 'border-amber-500 text-amber-800',
  run_superseded: 'border-amber-500 text-amber-800',
  post_rejected_stale: 'border-rose-500 text-rose-800',
  tool_denied: 'border-rose-500 text-rose-800',
  run_failed: 'border-rose-500 text-rose-800',
  approval_posted: 'border-emerald-500 text-emerald-800',
  escalation_decided: 'border-emerald-500 text-emerald-800',
}

function describe(e: AuditEntry): string {
  const p = e.payload as Record<string, unknown>
  switch (e.kind) {
    case 'head_changed': return `${String(p.reason) === 'push' ? 'Push' : 'Base changed'}: now ${String(p.newSha).slice(0, 7)}`
    case 'decision': return `${humanize(String(p.outcome))}: ${humanize(String(p.reasonCode))}`
    case 'decision_invalidated': return String(p.reason)
    case 'gate_evaluated': return `${p.passed ? 'All rules passed' : 'Rules failed'}, category ${String(p.category)}`
    case 'gate_rechecked': return `Re-checked before posting: ${p.passed ? 'still passes' : 'no longer passes'}`
    case 'model_output': return `${String(p.outcome).replace(/_/g, ' ')}${p.parsedOutput ? `: ${String((p.parsedOutput as { verdict: string }).verdict).replace('_', ' ')}` : ''}`
    case 'tool_requested': return `Allowed: ${String(p.tool)}`
    case 'tool_denied': return `Denied: ${String(p.tool)} (${String(p.denialReason).replace(/_/g, ' ')})`
    case 'approval_posted': return `Review ${String(p.reviewId)} posted with commit_id ${String(p.commitId).slice(0, 7)}`
    case 'approval_dismissed': return `Dismissed at the host: ${String(p.reason)}`
    case 'post_rejected_stale': return `Host refused: head is ${String(p.currentHead).slice(0, 7)}`
    case 'ci_reported': return `CI ${String(p.conclusion)}`
    case 'human_review_observed': return `${String(e.actor)}: ${String(p.state).toLowerCase().replace('_', ' ')}`
    case 'escalation_opened': return String(p.reasonCode).replace(/_/g, ' ')
    case 'escalation_decided': return `${String(p.resolution)}${p.note ? `: ${String(p.note)}` : ''}`
    default: return ''
  }
}

export function Timeline({ entries }: { entries: AuditEntry[] }) {
  return (
    <section aria-label="Timeline" className="card p-4">
      <h2 className="panel-title mb-3">Timeline, from the audit log</h2>
      <ol className="space-y-2">
        {entries.map((e) => {
          const tone = EMPHASIS[e.kind] ?? 'border-slate-200 text-slate-700'
          return (
            <li key={e.seq} className={`border-l-2 pl-3 text-sm ${tone}`}>
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-medium">{humanize(e.kind)}</span>
                {e.headSha && <Sha sha={e.headSha} />}
                <span className="text-xs text-slate-400">{e.actor} · {ago(e.createdAt)}</span>
              </div>
              <div className="break-words text-xs text-slate-500">{describe(e)}</div>
            </li>
          )
        })}
      </ol>
    </section>
  )
}
