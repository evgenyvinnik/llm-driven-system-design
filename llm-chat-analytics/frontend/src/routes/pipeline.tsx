/**
 * Ingest health across all orgs: where each Kafka partition is, the
 * watermarks derived from them, dedup and lateness counters, and rejections.
 */
import { createFileRoute } from '@tanstack/react-router'
import { ago, localTime } from '../lib/format'
import { usePipeline } from '../lib/queries'

export const Route = createFileRoute('/pipeline')({ component: Pipeline })

const tz = Intl.DateTimeFormat().resolvedOptions().timeZone

function Pipeline() {
  const { data, error } = usePipeline()
  if (error) return <p className="text-sm text-status-critical">{(error as Error).message}</p>
  if (!data) return <p className="text-sm text-ink-2">Loading pipeline status…</p>
  const c = data.counters
  const rejectedTotal = Object.entries(c).filter(([k]) => k.startsWith('rejected:')).reduce((s, [, v]) => s + v, 0)
  const maxRows = Math.max(...data.ingestedPerMinute.map((m) => m.rows), 1)
  return (
    <div className="space-y-4" data-testid="pipeline">
      <div>
        <h1 className="text-lg font-semibold">Pipeline</h1>
        <p className="text-sm text-ink-2">Times in your browser’s zone ({tz}). Refreshes every 5 seconds.</p>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {[
          ['Events stored', c.accepted ?? 0],
          ['Duplicates dropped', c.duplicates ?? 0],
          ['Late (changed a closed bucket)', c.late ?? 0],
          ['Rejected', rejectedTotal],
          ['Skipped on redelivery', c.already_inserted ?? 0],
        ].map(([label, v]) => (
          <div key={label} className="card px-4 py-3">
            <p className="text-xs text-ink-2">{label}</p>
            <p className="tabular text-xl font-semibold">{Number(v).toLocaleString()}</p>
          </div>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="card p-4">
          <h2 className="widget-title">Watermarks</h2>
          <table className="mt-2 w-full text-sm">
            <tbody className="tabular">
              <tr>
                <td className="py-1 text-ink-2">Ingested through (slowest partition)</td>
                <td className="py-1 text-right">{localTime(data.processedThrough, tz, 'MMM d HH:mm:ss')}</td>
              </tr>
              <tr>
                <td className="py-1 text-ink-2">Server stream complete through</td>
                <td className="py-1 text-right">{localTime(data.watermarks.server, tz, 'MMM d HH:mm:ss')}</td>
              </tr>
              <tr>
                <td className="py-1 text-ink-2">Client stream complete through</td>
                <td className="py-1 text-right">{localTime(data.watermarks.client, tz, 'MMM d HH:mm:ss')}</td>
              </tr>
            </tbody>
          </table>
          <h3 className="mt-4 text-xs font-semibold text-ink-2">Partitions</h3>
          <table className="mt-1 w-full text-xs">
            <thead className="text-ink-muted">
              <tr>
                <th className="py-1 text-left font-medium">#</th>
                <th className="py-1 text-left font-medium">Position</th>
                <th className="py-1 text-right font-medium">Backlog</th>
                <th className="py-1 text-right font-medium">Reported</th>
              </tr>
            </thead>
            <tbody className="tabular">
              {data.partitions.map((p) => (
                <tr key={p.partition} className="border-t" style={{ borderColor: 'var(--gridline)' }}>
                  <td className="py-1">{p.partition}</td>
                  <td className="py-1">{localTime(p.position, tz, 'MMM d HH:mm:ss')}</td>
                  <td className="py-1 text-right">{p.lag.toLocaleString()}</td>
                  <td className="py-1 text-right" style={{ color: p.stalled ? 'var(--status-critical)' : undefined }}>
                    {ago(p.updatedAt)} ago{p.stalled ? ' · stalled' : ''}
                  </td>
                </tr>
              ))}
              {data.missingPartitions.map((p) => (
                <tr key={`m${p}`}>
                  <td className="py-1">{p}</td>
                  <td colSpan={3} className="py-1 text-status-critical">
                    never reported: watermark unknown
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section className="card p-4">
          <h2 className="widget-title">Rows stored per minute (last 30 min)</h2>
          <div className="mt-1 flex items-center gap-4 text-xs text-ink-2">
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: 'var(--series-1)' }} /> on time
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: 'var(--series-2)' }} /> late
            </span>
          </div>
          <div className="mt-3 flex h-32 items-end gap-[2px]" role="img" aria-label="Rows stored per minute">
            {data.ingestedPerMinute.map((m) => (
              <div key={m.minute} className="flex flex-1 flex-col justify-end gap-[2px]" title={`${localTime(m.minute, tz, 'HH:mm')}: ${m.rows} rows, ${m.late} late`}>
                {m.late > 0 && <div className="w-full rounded-t-[2px]" style={{ height: `${(m.late / maxRows) * 100}%`, background: 'var(--series-2)' }} />}
                <div className={`w-full ${m.late > 0 ? '' : 'rounded-t-[2px]'}`} style={{ height: `${((m.rows - m.late) / maxRows) * 100}%`, background: 'var(--series-1)' }} />
              </div>
            ))}
          </div>
          <h3 className="mt-4 text-xs font-semibold text-ink-2">Rejected in the last 24 h</h3>
          {data.rejected.length === 0 ? (
            <p className="mt-1 text-xs text-ink-2">None.</p>
          ) : (
            <table className="mt-1 w-full text-xs">
              <tbody>
                {data.rejected.map((r) => (
                  <tr key={r.reason} className="border-t" style={{ borderColor: 'var(--gridline)' }}>
                    <td className="py-1 font-mono">{r.reason}</td>
                    <td className="tabular py-1 text-right">{r.count.toLocaleString()}</td>
                    <td className="py-1 pl-3 text-ink-2">{r.sampleDetail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </div>
  )
}
