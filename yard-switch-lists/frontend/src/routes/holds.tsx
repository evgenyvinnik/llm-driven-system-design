import { createFileRoute } from '@tanstack/react-router'
import { Chip } from '@/components/shared/Chips'
import { ErrorNote, Loading } from '@/components/shared/Loading'
import { clockDay } from '@/lib/format'
import { usePolling } from '@/lib/usePolling'
import { api } from '@/services/api'

export const Route = createFileRoute('/holds')({ component: HoldsPage })

const OUTCOME: Record<string, 'good' | 'warn' | 'muted'> = { applied: 'good', stale: 'warn', other_yard: 'muted', ignored_type: 'muted' }

function HoldsPage() {
  const { data, error } = usePolling(api.holds, 3000)
  const alerts = usePolling(api.alerts, 3000).data?.alerts ?? []
  if (error && !data) return <main className="page"><ErrorNote message={error} /></main>
  if (!data) return <Loading />
  return (
    <main className="page">
      <h1 className="text-lg font-semibold text-slate-900">Holds and events</h1>
      <p className="text-sm text-slate-600">
        Holds come from railcar-health as <code>CarHoldPlaced</code>, <code>CarHoldReleased</code> and <code>CarHoldMoved</code> events in that project&apos;s envelope. Each event is deduped by id, and each hold keeps the highest stream version it has seen, so duplicates and late deliveries are harmless.
      </p>
      <div className="card overflow-x-auto">
        <table className="w-full" aria-label="Holds">
          <thead>
            <tr>
              <th className="th">Car</th>
              <th className="th">Status</th>
              <th className="th">Reason</th>
              <th className="th">Where it is</th>
              <th className="th text-right">Stream version</th>
              <th className="th">Placed</th>
              <th className="th">Released</th>
            </tr>
          </thead>
          <tbody>
            {data.holds.map((h) => (
              <tr key={h.holdId} className="border-t border-slate-100">
                <td className="td font-mono text-xs font-semibold">{h.carId}</td>
                <td className="td"><Chip kind={h.status === 'active' || h.status === 'bad_ordered' ? 'bad' : 'good'}>{h.status}</Chip></td>
                <td className="td">{h.reason ?? '–'}</td>
                <td className="td text-xs">{h.position === 'on_track' ? `${h.trackId}${h.coupledTo ? `, coupled to ${h.coupledTo}` : ''}` : h.position ?? 'not in this yard'}</td>
                <td className="td num text-right">{h.streamVersion}</td>
                <td className="td num whitespace-nowrap">{clockDay(h.placedAt)}</td>
                <td className="td num whitespace-nowrap">{clockDay(h.releasedAt)}</td>
              </tr>
            ))}
            {data.holds.length === 0 && <tr><td className="td text-slate-500" colSpan={7}>No holds yet. Place one from the simulator.</td></tr>}
          </tbody>
        </table>
      </div>
      <h2 className="text-base font-semibold text-slate-900">Feed</h2>
      <div className="card overflow-x-auto">
        <table className="w-full" aria-label="Hold events">
          <thead>
            <tr>
              <th className="th">Event</th>
              <th className="th">Car</th>
              <th className="th">Stream</th>
              <th className="th">Occurred</th>
              <th className="th">Via</th>
              <th className="th">Outcome</th>
            </tr>
          </thead>
          <tbody>
            {data.events.map((e) => (
              <tr key={e.eventId} className="border-t border-slate-100">
                <td className="td text-xs">{e.type} v{e.version}</td>
                <td className="td font-mono text-xs">{e.carId}</td>
                <td className="td font-mono text-xs">{e.streamId.slice(0, 16)}… #{e.streamVersion}</td>
                <td className="td num whitespace-nowrap">{clockDay(e.occurredAt)}</td>
                <td className="td text-xs">{e.via}</td>
                <td className="td"><Chip kind={OUTCOME[e.outcome] ?? 'muted'}>{e.outcome}</Chip></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h2 className="text-base font-semibold text-slate-900">Alerts</h2>
      <ul className="card divide-y divide-slate-100 text-sm" aria-label="Alerts">
        {alerts.slice(0, 20).map((a) => (
          <li key={a.id} className="flex items-start gap-2 px-3 py-1.5">
            <Chip kind={a.status !== 'open' ? 'muted' : a.severity === 'critical' ? 'bad' : 'warn'}>{a.status === 'open' ? a.severity : a.status}</Chip>
            <span className="flex-1">{a.message}</span>
            <span className="num text-xs text-slate-500">{clockDay(a.simAt)}</span>
          </li>
        ))}
      </ul>
    </main>
  )
}
