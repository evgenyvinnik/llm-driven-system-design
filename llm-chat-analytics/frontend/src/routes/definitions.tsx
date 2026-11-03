/**
 * Metric definitions and the event contract, served by the API from the same
 * catalog the queries use. If a number is on a chart, its definition is here.
 */
import { createFileRoute } from '@tanstack/react-router'
import { localTime } from '../lib/format'
import { useMeta } from '../lib/queries'
import { useSession } from '../stores/session'
import { LockIcon } from '../components/icons'

export const Route = createFileRoute('/definitions')({ component: Definitions })

function Definitions() {
  const { data, isPending, error } = useMeta()
  const orgs = useSession((s) => s.orgs)
  if (isPending) return <p className="text-sm text-ink-2">Loading definitions…</p>
  if (error || !data) return <p className="text-sm text-status-critical">Could not load definitions.</p>
  return (
    <div className="space-y-6">
      <section>
        <h1 className="text-lg font-semibold">Metric definitions</h1>
        <p className="mt-1 max-w-3xl text-sm text-ink-2">
          Every number is bucketed by when the event happened (event time), not when it arrived. Daily buckets are calendar days in the org’s time zone. Distinct users and percentiles are merged from sketches, so they are never sums or averages of smaller buckets.
        </p>
        <div className="card mt-3 overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm" data-testid="definitions">
            <thead className="text-xs text-ink-muted">
              <tr>
                <th className="px-4 py-2 font-medium">Metric</th>
                <th className="px-4 py-2 font-medium">Definition</th>
                <th className="px-4 py-2 font-medium">Stream</th>
                <th className="px-4 py-2 font-medium">Notes</th>
              </tr>
            </thead>
            <tbody>
              {data.metrics.map((m) => (
                <tr key={m.id} className="border-t align-top" style={{ borderColor: 'var(--gridline)' }}>
                  <td className="px-4 py-2.5">
                    <p className="font-medium">{m.label}</p>
                    <p className="font-mono text-[11px] text-ink-muted">{m.id}</p>
                  </td>
                  <td className="max-w-xl px-4 py-2.5 text-ink-2">{m.definition}</td>
                  <td className="px-4 py-2.5 text-xs text-ink-2">{m.streams.join(' + ')}</td>
                  <td className="px-4 py-2.5 text-xs text-ink-2">
                    {m.approximate && <p>Approximate (sketch)</p>}
                    {m.sensitivity === 'billing' && (
                      <p className="flex items-center gap-1">
                        <LockIcon className="h-3 w-3" /> Billing: admins only
                      </p>
                    )}
                    {m.coverage && (
                      <p title={m.coverage.note}>
                        Collected from {localTime(m.coverage.collectedFrom, 'UTC', 'MMM d')}
                        {m.coverage.availableFrom !== m.coverage.collectedFrom && <>; rollups from {localTime(m.coverage.availableFrom, 'UTC', 'MMM d')}</>}
                      </p>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="card p-4">
          <h2 className="widget-title">Event contract (schema_version 1)</h2>
          <p className="mt-1 text-xs text-ink-2">Strict: an event with any other field is rejected before it is stored. Events never carry message content.</p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {data.eventContract.map((f) => (
              <span key={f.field} className="chip font-mono text-[11px] text-ink-2">
                {f.field}
                {f.optional ? '?' : ''}
              </span>
            ))}
          </div>
          <p className="mt-3 text-xs text-ink-2">
            Event types: <span className="font-mono">{data.eventTypes.join(', ')}</span>
          </p>
          <p className="mt-1 text-xs text-ink-2">
            Rejected outright, and counted as a privacy violation: <span className="font-mono">{data.forbiddenKeys.join(', ')}</span>
          </p>
        </div>
        <div className="card p-4 text-sm">
          <h2 className="widget-title">Lateness, privacy and access</h2>
          <ul className="mt-2 list-disc space-y-1.5 pl-5 text-ink-2">
            <li>Server events count as on time within {data.latenessAllowanceMs.server / 60_000} min, client events within {data.latenessAllowanceMs.client / 60_000} min. The “complete through” watermark is ingest progress minus that allowance.</li>
            <li>Events arriving later still count, in the bucket where they happened, up to {data.maxLatenessHours} h late. That is why yesterday’s number can change today. Later than that they are rejected.</li>
            <li>Breakdown rows and drill-downs covering fewer than {data.minCohortUsers} distinct users are hidden.</li>
            <li>Your roles: {orgs.map((o) => `${o.orgName} (${o.role})`).join(', ')}.</li>
          </ul>
        </div>
      </section>
    </div>
  )
}
