import { ShareIcon, StopIcon } from '@/components/icons'
import { StatusBadge } from '@/components/shared'
import { formatCount, formatMs, versionLabel } from '@/lib/format'
import type { LiveRun } from '@/stores/runs-store'
import { isTerminal } from '@/types'

interface Props {
  run: LiveRun
  label?: string
  onStop: () => void
  onShare: () => void
}

export function RunOutput({ run, label, onStop, onShare }: Props) {
  const active = !isTerminal(run.status)
  return (
    <div className="card flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-slate-100 px-3 py-2">
        {label && <span className="chip bg-slate-800 text-white">{label}</span>}
        <span className="whitespace-nowrap font-mono text-xs font-medium text-slate-800">{run.model}</span>
        <span className="chip whitespace-nowrap bg-slate-100 text-slate-600" title="The prompt text this run executed">
          {versionLabel(run.version, run.savedVersion)}
        </span>
        <StatusBadge status={run.status} />
        {run.connection === 'reconnecting' && <span className="text-xs text-amber-700">reconnecting…</span>}
        <div className="ml-auto flex items-center gap-1">
          {active ? (
            <button className="btn-secondary px-2 py-1 text-xs" onClick={onStop} disabled={run.cancelRequested}>
              <StopIcon className="h-3 w-3" /> {run.cancelRequested ? 'Stopping…' : 'Stop'}
            </button>
          ) : (
            <button className="btn-ghost px-2 py-1 text-xs" onClick={onShare}>
              <ShareIcon className="h-3.5 w-3.5" /> Share
            </button>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {run.output ? (
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-800">
            {run.output}
            {active && <span className="ml-0.5 inline-block h-4 w-1.5 translate-y-0.5 animate-blink bg-accent-500" />}
          </p>
        ) : (
          <p className="text-sm text-slate-400">{active ? (run.status === 'queued' ? 'Queued…' : 'Waiting for the first token…') : 'No output.'}</p>
        )}
        {run.status === 'failed' && (
          <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
            <span className="font-semibold">{run.errorCode ?? 'Failed'}</span>: {run.errorMessage ?? 'The run failed.'}
            {run.outputTruncated && ' The output above is partial.'}
          </div>
        )}
        {run.status === 'cancelled' && (
          <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            Stopped{run.outputTruncated ? ' — the output above is what had been generated.' : ' before any output.'}
          </div>
        )}
        {run.finishReason === 'length' && (
          <div className="mt-3 text-xs text-slate-500">Stopped at the max token limit ({run.config.maxTokens}).</div>
        )}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-slate-100 px-3 py-2 text-xs text-slate-500">
        <span>
          Tokens <span className="tabular-nums text-slate-700">{formatCount(run.usage.inputTokens)}</span> in ·{' '}
          <span className="tabular-nums text-slate-700">{formatCount(run.usage.outputTokens)}</span> out
        </span>
        <span>
          First token <span className="tabular-nums text-slate-700">{formatMs(run.usage.ttftMs)}</span>
        </span>
        <span>
          Total <span className="tabular-nums text-slate-700">{formatMs(run.usage.durationMs)}</span>
        </span>
        <span className="ml-auto">
          temp {run.config.temperature} · max {run.config.maxTokens}
        </span>
      </div>
    </div>
  )
}
