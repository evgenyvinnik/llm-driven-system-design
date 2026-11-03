/**
 * The honest freshness label. It states what the pipeline can actually claim:
 * events before the watermark have been counted. It is a different clock from
 * "last refreshed": a dashboard can refresh every 15 seconds and still show
 * data that is an hour behind if ingest is stuck.
 */
import { useState } from 'react'
import type { FreshnessResponse } from '../../lib/api'
import { ago, localTime, zoneAbbrev } from '../../lib/format'
import { useFreshness } from '../../lib/queries'
import { AlertIcon, CheckIcon, ClockIcon } from '../icons'

type Level = 'good' | 'warning' | 'critical' | 'unknown'

function freshnessLevel(f: FreshnessResponse | undefined, now = Date.now()): { level: Level; text: string } {
  if (!f || !f.watermarks.client || !f.watermarks.server) return { level: 'unknown', text: 'Freshness unknown' }
  const behind = now - Date.parse(f.watermarks.client)
  if (f.backlog > 0 && behind > 30 * 60_000) return { level: 'critical', text: `Catching up: ${f.backlog.toLocaleString()} events queued` }
  if (f.stalledPartitions.length > 0) return { level: 'critical', text: 'Ingest stalled' }
  if (behind > 60 * 60_000) return { level: 'critical', text: `${ago(f.watermarks.client, now)} behind` }
  if (behind > f.allowanceMs.client + 5 * 60_000) return { level: 'warning', text: `Delayed: ${ago(f.watermarks.client, now)} behind` }
  return { level: 'good', text: 'Up to date' }
}

const COLORS: Record<Level, string> = { good: 'var(--status-good)', warning: 'var(--status-warning)', critical: 'var(--status-critical)', unknown: 'var(--text-muted)' }

export function FreshnessLabel({ org, timeZone }: { org: string; timeZone: string }) {
  const { data, dataUpdatedAt, error } = useFreshness(org)
  const [open, setOpen] = useState(false)
  const { level, text } = freshnessLevel(data)
  const Icon = level === 'good' ? CheckIcon : level === 'unknown' ? ClockIcon : AlertIcon
  const revised = data?.days.filter((d) => d.lateEvents > 0 && d.lastRevisedAt) ?? []
  return (
    <div className="relative">
      <button type="button" className="flex items-center gap-2 rounded-md px-2 py-1 text-xs hover:bg-plane" onClick={() => setOpen((o) => !o)} aria-expanded={open} data-testid="freshness">
        <span className="flex items-center gap-1 font-medium" style={{ color: COLORS[level] }}>
          <Icon className="h-3.5 w-3.5" />
          <span className="text-ink">{text}</span>
        </span>
        <span className="text-ink-2">
          · complete through <strong className="tabular font-medium text-ink">{localTime(data?.watermarks.client, timeZone, 'MMM d HH:mm')}</strong> {zoneAbbrev(timeZone)}
        </span>
      </button>
      {open && data && (
        <div className="card absolute right-0 z-20 mt-1 w-[22rem] p-3 text-xs shadow-lg">
          <p className="mb-2 text-ink-2">
            Events that happened before the watermark have almost certainly all been counted. Later buckets are marked partial. Late arrivals (up to {data.maxLatenessHours} h) can still revise earlier days.
          </p>
          <table className="w-full">
            <tbody className="tabular">
              <tr>
                <td className="py-0.5 text-ink-2">Ingested through</td>
                <td className="py-0.5 text-right">{localTime(data.processedThrough, timeZone, 'MMM d HH:mm:ss')}</td>
              </tr>
              <tr>
                <td className="py-0.5 text-ink-2">Server events complete through</td>
                <td className="py-0.5 text-right">{localTime(data.watermarks.server, timeZone, 'MMM d HH:mm')} (allow {data.allowanceMs.server / 60_000} min)</td>
              </tr>
              <tr>
                <td className="py-0.5 text-ink-2">Client events complete through</td>
                <td className="py-0.5 text-right">{localTime(data.watermarks.client, timeZone, 'MMM d HH:mm')} (allow {data.allowanceMs.client / 60_000} min)</td>
              </tr>
              <tr>
                <td className="py-0.5 text-ink-2">Queued in Kafka</td>
                <td className="py-0.5 text-right">{data.backlog.toLocaleString()} events</td>
              </tr>
            </tbody>
          </table>
          {revised.length > 0 && (
            <div className="mt-2 border-t pt-2" style={{ borderColor: 'var(--gridline)' }}>
              <p className="mb-1 font-medium text-ink">Recently revised by late events</p>
              {revised.map((d) => (
                <p key={d.localDate} className="text-ink-2">
                  {d.localDate}: +{d.lateEvents.toLocaleString()} late ({((d.lateEvents / Math.max(d.events, 1)) * 100).toFixed(1)}%), last at {localTime(d.lastRevisedAt, timeZone, 'MMM d HH:mm')}
                </p>
              ))}
            </div>
          )}
          <p className="mt-2 text-ink-muted">Label checked {ago(new Date(dataUpdatedAt).toISOString())} ago{error ? ' (last check failed)' : ''}.</p>
        </div>
      )}
    </div>
  )
}
