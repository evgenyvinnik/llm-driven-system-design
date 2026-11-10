import { createFileRoute } from '@tanstack/react-router'
import { BurstControl } from '@/components/ops/BurstControl'
import { StartsChart } from '@/components/ops/StartsChart'
import { EmptyNote, ErrorNote, Loading, Panel } from '@/components/shared/Feedback'
import { millis, timeAgo } from '@/lib/format'
import { usePoll } from '@/lib/use-poll'
import { api } from '@/services/api'

export const Route = createFileRoute('/ops')({ component: Ops })

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="card p-3">
      <div className="panel-title">{label}</div>
      <div className="num mt-1 text-2xl font-semibold text-slate-900">{value}</div>
      {note && <div className="mt-0.5 text-xs text-slate-500">{note}</div>}
    </div>
  )
}

function Ops() {
  const { data, error, reload } = usePoll(api.ops, 2000)
  if (!data) return error ? <div className="page"><ErrorNote message={error} /></div> : <Loading />
  const queued = data.queues.reduce((n, q) => n + q.queued, 0)
  const attention = data.repositories.reduce((n, r) => n + r.attention, 0)
  const names = data.repositories.map((r) => r.fullName)
  return (
    <div className="page">
      <h1 className="h1">Operations</h1>
      {error && <ErrorNote message={error} />}
      <div className="grid gap-3 md:grid-cols-4">
        <Stat label="Runners online" value={`${data.fleet.online} / ${data.fleet.total}`} />
        <Stat label="Slots busy" value={`${data.fleet.busy} / ${data.fleet.slots}`} note="across all organizations" />
        <Stat label="Jobs queued" value={String(queued)} note="in the repositories you can read" />
        <Stat label="Needs attention" value={String(attention)} note="waiting for a person" />
      </div>
      <div className="grid gap-5 md:grid-cols-[1fr_2fr]">
        <Panel title="Queue depth per label" label="Queue depth panel">
          {data.queues.length === 0 ? (
            <div className="p-4"><EmptyNote>Nothing is queued.</EmptyNote></div>
          ) : (
            <table className="w-full" aria-label="Queue depth">
              <thead className="border-b border-slate-100">
                <tr>
                  <th className="th">Label</th>
                  <th className="th">Queued</th>
                  <th className="th">Oldest</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.queues.map((q) => (
                  <tr key={q.label}>
                    <td className="td font-mono text-xs">{q.label}</td>
                    <td className="td num">{q.queued}</td>
                    <td className="td num text-xs">{millis(q.oldestMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
        <Panel title="Per-repository concurrency" label="Concurrency panel">
          <table className="w-full" aria-label="Repository concurrency">
            <thead className="border-b border-slate-100">
              <tr>
                <th className="th">Repository</th>
                <th className="th">Running / limit</th>
                <th className="th">Queued</th>
                <th className="th">Waiting</th>
                <th className="th">Attention</th>
                <th className="th">Oldest queued</th>
                <th className="th">Last served</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.repositories.map((r) => (
                <tr key={r.id}>
                  <td className="td text-xs font-medium">{r.fullName}</td>
                  <td className="td num">
                    {r.running} / {r.limit}
                  </td>
                  <td className="td num">{r.queued}</td>
                  <td className="td num">{r.waiting}</td>
                  <td className="td num">{r.attention}</td>
                  <td className="td num text-xs">{millis(r.oldestQueuedMs)}</td>
                  <td className="td text-xs">{timeAgo(r.lastClaimedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>
      <Panel title="Burst test" label="Burst test panel">
        <BurstControl repositories={data.repositories} onFired={reload} />
      </Panel>
      <Panel title={`Job starts, last ${Math.round(data.windowSeconds / 60)} minutes`} label="Starts panel">
        {data.timeline.length > 0 ? <StartsChart timeline={data.timeline} repositories={names} /> : <div className="p-4"><EmptyNote>No job has started in this window. Fire a burst, or push from the fixture panel.</EmptyNote></div>}
      </Panel>
      <Panel title="How the last few minutes were shared out" label="Burst behaviour panel">
        {data.burst.length === 0 ? (
          <div className="p-4"><EmptyNote>No jobs in this window.</EmptyNote></div>
        ) : (
          <table className="w-full" aria-label="Burst behaviour">
            <thead className="border-b border-slate-100">
              <tr>
                <th className="th">Repository</th>
                <th className="th">Jobs started</th>
                <th className="th">Peak concurrent / limit</th>
                <th className="th">Wait, median</th>
                <th className="th">Wait, worst</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.burst.map((b) => (
                <tr key={b.repoId}>
                  <td className="td text-xs font-medium">{b.fullName}</td>
                  <td className="td num">{b.jobs}</td>
                  <td className="td num">
                    {b.peakConcurrent} / {b.limit}
                  </td>
                  <td className="td num text-xs">{millis(b.waitP50Ms)}</td>
                  <td className="td num text-xs">{millis(b.waitMaxMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  )
}
