import { useEffect, useState } from 'react'
import { api } from '@/services/api'
import type { TurnStep } from '@/types'

const KIND_STYLE: Record<string, string> = {
  model_call: 'bg-violet-100 text-violet-700',
  tool_call: 'bg-sky-100 text-sky-700',
  policy: 'bg-amber-100 text-amber-800',
  notice: 'bg-slate-100 text-slate-600',
  wrap_up: 'bg-amber-100 text-amber-800',
  prefetch: 'bg-teal-100 text-teal-700',
  compaction: 'bg-slate-100 text-slate-600',
}

export function describeStep(s: Pick<TurnStep, 'kind' | 'name' | 'detail'>): string {
  const d = s.detail as Record<string, unknown>
  if (s.kind === 'model_call') {
    const calls = (d.toolCalls as string[] | undefined)?.join(', ')
    return `${s.name} → ${d.stopReason}${calls ? ` (${calls})` : ''}${d.fallbackUsed ? ' · fallback' : ''}${Number(d.attempts) > 1 ? ` · ${d.attempts} attempts` : ''}`
  }
  if (s.kind === 'tool_call') return `${s.name} ${d.ok === false ? `failed: ${JSON.stringify(d.error)}` : `· ${d.summary ?? 'ok'}`}${d.replayed ? ' · replayed (idempotent)' : ''}${d.executedBy === 'browser' ? ' · in browser' : ''}`
  if (s.kind === 'policy') return d.userDecision ? `user ${d.userDecision} ${s.name}` : `${s.name}: ${d.action} (${d.rule})`
  if (s.kind === 'prefetch') return s.name === 'retrieved' ? `prefetched ${(d.passages as string[]).join(', ')} for "${(d.queries as string[]).join('", "')}"` : 'prefetch skipped'
  return String(d.message ?? d.reason ?? s.name ?? '')
}

/** "What I did": the turn's audit trail, step by step. */
export function StepsList({ turnId }: { turnId: string }) {
  const [steps, setSteps] = useState<TurnStep[] | null>(null)
  useEffect(() => {
    api.turnSteps(turnId).then((r) => setSteps(r.steps)).catch(() => setSteps([]))
  }, [turnId])
  if (!steps) return <div className="text-xs text-slate-400">Loading…</div>
  return (
    <ol className="space-y-1">
      {steps.map((s) => (
        <li key={s.id} className="flex items-start gap-2 text-[11px] text-slate-600">
          <span className={`chip shrink-0 px-1.5 py-0 text-[10px] ${KIND_STYLE[s.kind]}`}>{s.kind.replace('_', ' ')}</span>
          <span className="min-w-0 break-words">{describeStep(s)}</span>
          {s.latencyMs !== null && <span className="ml-auto shrink-0 text-slate-400">{s.latencyMs}ms</span>}
        </li>
      ))}
    </ol>
  )
}
