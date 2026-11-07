import { Link } from '@tanstack/react-router'
import { LatencyBar } from '@/components/shared/LatencyBar'
import { StatusChip } from '@/components/shared/StatusChip'
import { int } from '@/lib/format'
import { useConsoleStore } from '@/stores/console-store'

export function OutputPanel() {
  const run = useConsoleStore((s) => s.run)
  const live = run.phase === 'running' || run.phase === 'queued' || run.phase === 'submitting'
  const execMs = run.latency?.exec_ms ?? null

  return (
    <section className="card flex min-h-[420px] flex-col" aria-label="Output">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-4 py-2.5">
        <h2 className="panel-title">Output</h2>
        <StatusChip status={run.phase} />
        {run.requestId && (
          <Link to="/requests/$requestId" params={{ requestId: run.requestId }} className="font-mono text-xs text-accent-700 hover:underline">
            {run.requestId}
          </Link>
        )}
        {run.backendId && <span className="chip bg-slate-100 text-slate-700">backend {run.backendId}</span>}
        {run.version && <span className="chip bg-slate-100 text-slate-700">{run.version}</span>}
        {run.affinity && <span className={`chip ${run.affinity === 'primary' ? 'bg-emerald-50 text-emerald-800' : 'bg-amber-50 text-amber-800'}`}>{run.affinity}</span>}
      </div>
      <div className="flex-1 overflow-auto px-4 py-3">
        {run.phase === 'idle' ? (
          <p className="text-sm text-slate-500">Pick a key and a mode, then send a request. Streamed tokens appear here as they are generated.</p>
        ) : (
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-800" data-testid="output-text">
            {run.text}
            {live && <span className="ml-0.5 inline-block h-4 w-1.5 animate-blink bg-slate-700 align-middle" />}
          </p>
        )}
        {run.error && (
          <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
            <span className="font-mono text-xs">{run.error.type}</span> {run.error.message}
            {run.error.retryAfter && <span className="ml-1 font-medium">Retry after {run.error.retryAfter}s.</span>}
          </div>
        )}
      </div>
      <div className="space-y-3 border-t border-slate-100 px-4 py-3">
        {(run.queueMs !== null || run.latency) && <LatencyBar queueMs={run.latency?.queue_ms ?? run.queueMs} ttftMs={run.latency?.ttft_ms ?? run.ttftMs} execMs={execMs} />}
        {run.usage && (
          <p className="text-xs text-slate-600">
            Usage: <span className="num font-medium">{int(run.usage.input_tokens)}</span> input ({int(run.usage.cache_read_input_tokens)} from prefix cache) ·{' '}
            <span className="num font-medium">{int(run.usage.output_tokens)}</span> output
            {run.latency?.tokens_per_sec ? ` · ${run.latency.tokens_per_sec} tokens/s` : ''}
          </p>
        )}
        {run.notes.length > 0 && (
          <ol className="space-y-0.5 text-xs" aria-label="Request timeline">
            {run.notes.map((n, i) => (
              <li key={i} className={n.tone === 'error' ? 'text-red-700' : n.tone === 'warn' ? 'text-amber-800' : 'text-slate-500'}>
                {new Date(n.at).toLocaleTimeString('en-US', { hour12: false })} · {n.text}
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  )
}
