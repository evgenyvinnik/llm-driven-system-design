import { ms, num } from '@/lib/format'
import type { RunDetail } from '@/types'

function Stat({ label, value, tone = 'text-slate-900', hint }: { label: string; value: string; tone?: string; hint?: string }) {
  return (
    <div className="card px-3 py-2">
      <div className="panel-title">{label}</div>
      <div className={`num text-lg font-semibold ${tone}`}>{value}</div>
      {hint && <div className="text-[11px] text-slate-500">{hint}</div>}
    </div>
  )
}

/** Task counts (case × sample) and usage. Errored is never folded into anything else. */
export function ProgressPanel({ detail }: { detail: RunDetail }) {
  const { progress, usage, run } = detail
  return (
    <div className="grid grid-cols-4 gap-3 lg:grid-cols-8">
      <Stat label="Succeeded" value={num(progress.succeeded)} tone="text-emerald-700" hint={`of ${run.totalTasks} tasks`} />
      <Stat label="Errored" value={num(progress.errored)} tone={progress.errored > 0 ? 'text-rose-700' : 'text-slate-400'} hint="excluded, never averaged" />
      <Stat label="Cancelled" value={num(progress.cancelled)} tone={progress.cancelled > 0 ? 'text-amber-700' : 'text-slate-400'} />
      <Stat label="Pending · running" value={`${progress.pending} · ${progress.running}`} hint={`${usage.liveLeases}/${run.concurrencyLimit} leases live`} />
      <Stat label="Model calls" value={num(usage.modelCalls)} hint="attempts, incl. retries" />
      <Stat label="Tokens in · out" value={`${num(usage.inputTokens)} · ${num(usage.outputTokens)}`} />
      <Stat label="Avg queue" value={ms(usage.avgQueueMs)} hint="created → claimed" />
      <Stat label="Avg TTFT · gen" value={`${ms(usage.avgTtftMs)} · ${ms(usage.avgGenerationMs)}`} />
    </div>
  )
}
