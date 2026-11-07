import { createFileRoute, Link } from '@tanstack/react-router'
import { useCallback, type ReactNode } from 'react'
import { ArrowLeftIcon } from '@/components/icons'
import { LatencyBar } from '@/components/shared/LatencyBar'
import { Loading } from '@/components/shared/Loading'
import { ClassChip, StatusChip } from '@/components/shared/StatusChip'
import { clock, int, ms } from '@/lib/format'
import { usePoll } from '@/lib/use-poll'
import { api } from '@/services/api'

export const Route = createFileRoute('/requests/$requestId')({ component: RequestPage })

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-b border-slate-100 py-1.5 text-sm last:border-0">
      <dt className="text-slate-500">{label}</dt>
      <dd className="text-right text-slate-800">{value}</dd>
    </div>
  )
}

function RequestPage() {
  const { requestId } = Route.useParams()
  const load = useCallback(() => api.request(requestId), [requestId])
  // Poll while the request is open; an async result can be fetched any time later by id.
  const { data, error } = usePoll(load, 1500)
  const r = data?.request
  if (!r) return error ? <main className="mx-auto max-w-5xl px-4 py-6 text-sm text-red-700">{error}</main> : <Loading />
  const u = r.usage

  return (
    <main className="mx-auto max-w-5xl space-y-4 px-4 py-6">
      <Link to="/console" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800">
        <ArrowLeftIcon /> Console
      </Link>
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="font-mono text-lg font-semibold text-slate-900">{r.id}</h1>
        <StatusChip status={r.status} />
        <ClassChip cls={r.priorityClass} />
        <span className="chip bg-slate-100 text-slate-700">{r.mode}</span>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <section className="card p-4" aria-label="Lifecycle">
          <h2 className="panel-title">Lifecycle</h2>
          <dl className="mt-2">
            <Row label="Key" value={`${r.orgName} / ${r.keyName}`} />
            <Row label="Created (id assigned at the edge)" value={clock(r.createdAt)} />
            <Row label="Dispatched" value={`${clock(r.dispatchedAt)}${r.backendId ? ` → ${r.backendId}` : ''}`} />
            <Row label="First token (pinned to backend)" value={clock(r.firstTokenAt)} />
            <Row label="Finished" value={clock(r.finishedAt)} />
            <Row label="Attempts" value={`${r.attempts}${r.affinity ? ` · ${r.affinity === 'primary' ? 'prefix owner' : 'spilled'}` : ''}`} />
            <Row label="Model version" value={r.modelVersion ?? '–'} />
            {r.cancelReason && <Row label="Cancel reason" value={r.cancelReason} />}
          </dl>
        </section>
        <section className="card space-y-3 p-4" aria-label="Usage">
          <h2 className="panel-title">Usage and latency</h2>
          <LatencyBar queueMs={u?.queueMs ?? null} ttftMs={u?.ttftMs ?? null} execMs={u?.execMs ?? null} />
          <dl>
            <Row label="Reserved at admission (input estimate + max_tokens)" value={int(r.reservedTokens)} />
            <Row label="Input tokens (cached prefix)" value={u ? `${int(u.inputTokens)} (${int(u.cachedInputTokens)})` : '–'} />
            <Row label="Output tokens" value={u ? int(u.outputTokens) : '–'} />
            <Row label="Refunded to the bucket" value={u ? int(u.refundedTokens) : '–'} />
            <Row label="Total time" value={ms(u?.totalMs)} />
            <Row label="Decode speed" value={u?.tokensPerSec ? `${u.tokensPerSec} tokens/s` : '–'} />
          </dl>
        </section>
      </div>
      {r.error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
          <span className="font-mono text-xs">{r.error.type}</span> {r.error.message}
        </div>
      )}
      <section className="card p-4" aria-label="Output">
        <h2 className="panel-title">Output{r.status === 'cancelled' && r.outputText ? ' (partial, before cancel)' : ''}</h2>
        <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-slate-800">{r.outputText ?? (r.status === 'queued' || r.status === 'running' ? 'In progress…' : '–')}</p>
      </section>
      <section className="card p-4" aria-label="Input">
        <h2 className="panel-title">Input</h2>
        {r.input?.system && <p className="mt-2 line-clamp-3 text-xs text-slate-500">System: {r.input.system}</p>}
        {r.input?.messages.map((m, i) => (
          <p key={i} className="mt-2 text-sm text-slate-800">
            <span className="font-medium">{m.role}:</span> {typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}
          </p>
        ))}
      </section>
    </main>
  )
}
