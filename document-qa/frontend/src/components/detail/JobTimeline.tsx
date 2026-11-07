/** Processing timeline: every job of the document, grouped by version, with each attempt (worker, outcome, error, detail). */
import { StatusChip } from '@/components/shared/Chips'
import { STAGE_LABEL, STAGE_ORDER, duration, progressText, time } from '@/lib/format'
import type { AttemptItem, JobItem, VersionItem } from '@/types'

function detailText(d: Record<string, unknown>): string {
  const parts: string[] = []
  if (typeof d.chunksWrittenBeforeExit === 'number') parts.push(`wrote ${d.chunksWrittenBeforeExit}/${String(d.total ?? '?')} chunks, then the worker exited`)
  if (typeof d.chunks === 'number') parts.push(`${d.chunks} chunks`)
  if (typeof d.embedded === 'number') parts.push(`embedded ${d.embedded}${typeof d.alreadyEmbedded === 'number' && d.alreadyEmbedded > 0 ? ` (${d.alreadyEmbedded} already done)` : ''}`)
  if (typeof d.rateLimitedRetries === 'number' && d.rateLimitedRetries > 0) parts.push(`${d.rateLimitedRetries} rate-limited retries`)
  if (typeof d.indexed === 'number') parts.push(`${d.indexed} index entries`)
  if (typeof d.chars === 'number') parts.push(`${d.chars} chars`)
  if (typeof d.entriesUpdated === 'number') parts.push(`${d.entriesUpdated} index rows updated`)
  if (typeof d.retryInMs === 'number') parts.push(`retry in ${d.retryInMs} ms`)
  if (typeof d.skipped === 'string') parts.push(`skipped: ${d.skipped}`)
  if (typeof d.cancelled === 'string') parts.push(`cancelled: ${d.cancelled}`)
  return parts.join(' · ')
}

function Attempt({ a }: { a: AttemptItem }) {
  const extra = detailText(a.detail)
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 text-xs">
      <span className="num w-16 shrink-0 text-slate-500">attempt {a.attemptNo}</span>
      <span className="font-mono text-slate-600">{a.workerId}</span>
      {a.outcome ? <StatusChip status={a.outcome} /> : <StatusChip status="running" />}
      <span className="text-slate-400">
        {time(a.startedAt)} · {duration(a.startedAt, a.finishedAt)}
      </span>
      {extra && <span className="text-slate-600">{extra}</span>}
      {a.error && <span className="basis-full pl-16 text-rose-800">{a.error}</span>}
    </li>
  )
}

function Job({ job }: { job: JobItem }) {
  const prog = progressText(job.progress)
  const waiting = typeof job.progress.waiting === 'string' ? job.progress.waiting : null
  return (
    <li className="rounded-md border border-slate-200 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium text-slate-800">{STAGE_LABEL[job.stage] ?? job.stage}</span>
        <StatusChip status={job.status} />
        <span className="num text-xs text-slate-500">
          attempts {job.attempts}/{job.maxAttempts}
        </span>
        {prog && <span className="num text-xs text-slate-500">progress {prog}</span>}
        {waiting && <span className="text-xs text-amber-700">{waiting}</span>}
      </div>
      {job.lastError && job.status !== 'succeeded' && <div className="mt-1 text-xs text-rose-800">{job.lastError}</div>}
      {job.attemptLog.length > 0 && (
        <ol className="mt-1.5 space-y-1 border-l-2 border-slate-100 pl-2">
          {job.attemptLog.map((a) => (
            <Attempt key={`${a.attemptNo}-${a.startedAt}`} a={a} />
          ))}
        </ol>
      )}
    </li>
  )
}

export function JobTimeline({ jobs, versions }: { jobs: JobItem[]; versions: VersionItem[] }) {
  const groups = new Map<string, JobItem[]>()
  for (const j of jobs) {
    const key = j.versionId ?? 'document'
    groups.set(key, [...(groups.get(key) ?? []), j])
  }
  const label = (key: string) => {
    if (key === 'document') return 'Document-level jobs'
    const v = versions.find((x) => x.id === key)
    return v ? `Version ${v.versionNo}` : key
  }
  const keys = [...groups.keys()].sort((a, b) => {
    const va = versions.find((x) => x.id === a)?.versionNo ?? 1e9
    const vb = versions.find((x) => x.id === b)?.versionNo ?? 1e9
    return vb - va
  })
  return (
    <section className="card p-4" aria-label="Processing timeline">
      <h2 className="panel-title mb-2">Processing timeline</h2>
      <div className="space-y-3">
        {keys.map((k) => (
          <div key={k}>
            <h3 className="mb-1 text-xs font-semibold text-slate-600">{label(k)}</h3>
            <ul className="space-y-1.5">
              {[...(groups.get(k) ?? [])]
                .sort((a, b) => STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage))
                .map((j) => (
                  <Job key={j.id} job={j} />
                ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  )
}
