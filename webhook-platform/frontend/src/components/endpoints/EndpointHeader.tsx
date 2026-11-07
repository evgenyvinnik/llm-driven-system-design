import { AlertIcon, PauseIcon, ReplayIcon } from '@/components/icons'
import { EndpointStatusChip } from '@/components/shared/Chips'
import { DISABLED_REASON_LABEL, ago, until } from '@/lib/format'
import { api } from '@/services/api'
import type { Endpoint } from '@/types'

export function EndpointHeader({ endpoint: e, onChange }: { endpoint: Endpoint; onChange: () => void }) {
  async function toggle() {
    if (e.status === 'active') await api.disableEndpoint(e.id)
    else await api.enableEndpoint(e.id)
    onChange()
  }
  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="h1">{e.description || e.id}</h1>
            <EndpointStatusChip status={e.status} probing={e.health.probing} paused={Boolean(e.pausedUntil)} />
          </div>
          <div className="mt-1 truncate font-mono text-sm text-slate-600">{e.url}</div>
          <div className="mt-0.5 text-xs text-slate-400">{e.id} · created {ago(e.createdAt)}</div>
        </div>
        <button type="button" className={e.status === 'active' ? 'btn-danger' : 'btn-primary'} onClick={() => void toggle()}>
          {e.status === 'active' ? <><PauseIcon /> Disable</> : <><ReplayIcon /> Re-enable</>}
        </button>
      </div>
      {e.status === 'disabled' && (
        <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
          <AlertIcon className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            Disabled {ago(e.disabledAt)}: {DISABLED_REASON_LABEL[e.disabledReason ?? ''] ?? e.disabledReason}. New events are not sent here and waiting deliveries were marked failed.
            Fix the receiver, re-enable, then use <strong>Replay failed</strong> below.
          </div>
        </div>
      )}
      {e.status === 'active' && e.pausedUntil && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900" role="status">
          The receiver answered 429; nothing is sent until its Retry-After passes (in {until(e.pausedUntil)}).
        </div>
      )}
      {e.status === 'active' && e.health.probing && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900" role="status">
          {e.consecutiveFailures} failures in a row since {ago(e.failingSince)}. Probing with one request at a time instead of {e.maxConcurrency}; full speed resumes after the first success.
        </div>
      )}
    </div>
  )
}
