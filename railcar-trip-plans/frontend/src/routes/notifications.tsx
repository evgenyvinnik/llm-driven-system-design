import { createFileRoute, Link } from '@tanstack/react-router'
import { Empty, ErrorNote, Loading, PageHeader, StatTile } from '@/components/shared/Loading'
import { fmtTime } from '@/lib/format'
import { usePoll } from '@/lib/hooks'
import { api } from '@/services/api'
import { useAuthStore } from '@/stores/auth-store'
import type { Digest } from '@/types'

export const Route = createFileRoute('/notifications')({ component: Notifications })

const KIND_STYLE: Record<string, string> = { replanned: 'bg-amber-50 text-amber-800', eta_change: 'bg-sky-50 text-sky-800', bad_order: 'bg-red-50 text-red-700', delivered: 'bg-emerald-50 text-emerald-800' }

function kindCounts(d: Digest): Array<[string, number]> {
  const counts: Record<string, number> = {}
  for (const l of d.lines) {
    const k = l.kinds.includes('delivered') ? 'delivered' : l.kinds.includes('replanned') ? 'replanned' : l.kinds.includes('bad_order') ? 'bad_order' : 'eta_change'
    counts[k] = (counts[k] ?? 0) + 1
  }
  return Object.entries(counts)
}

export function Notifications() {
  const user = useAuthStore((s) => s.user)!
  const { data, error } = usePoll(() => api.notifications(), [])
  const t = data?.totals
  return (
    <div className="page">
      <PageHeader
        title={user.role === 'shipper' ? 'My notifications' : 'Shipper digests'}
        subtitle="One digest per shipper per batching window: changes for the same car collapse to one line, ETA moves are measured against what the shipper was last told, and small wobbles are suppressed."
      />
      {t && (
        <div className="mb-4 grid grid-cols-3 gap-3">
          <StatTile label="Car-level changes" value={t.items} hint="ETA moves, replans, bad orders, deliveries" />
          <StatTile label="Digests sent" value={t.digests} tone="good" />
          <StatTile label="Collapse ratio" value={t.digests ? `${(t.items / t.digests).toFixed(1)} : 1` : '—'} hint={`${t.suppressed} items in windows that had nothing worth sending`} />
        </div>
      )}
      {error && <ErrorNote message={error} />}
      {!data ? (
        <Loading />
      ) : data.digests.length === 0 ? (
        <Empty>No digests yet.</Empty>
      ) : (
        <ul className="space-y-3" aria-label="Digests">
          {data.digests.map((d) => (
            <li key={d.digest_id} className="card p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <span className="text-sm font-semibold text-slate-900">{d.shipper_name}</span>
                  <span className="ml-2 text-sm text-slate-600">{d.lines.length} cars · {d.item_count} changes collapsed ({d.suppressed_count} folded in)</span>
                  <span className="ml-2 inline-flex gap-1">
                    {kindCounts(d).map(([k, n]) => (
                      <span key={k} className={`chip ${KIND_STYLE[k] ?? 'bg-slate-100 text-slate-600'}`}>{n} {k.replace('_', ' ')}</span>
                    ))}
                  </span>
                </div>
                <span className="text-xs text-slate-500">{fmtTime(d.sim_time)} · <span className="font-mono">{d.digest_id}</span></span>
              </div>
              <ul className="mt-2 space-y-0.5 text-sm text-slate-700">
                {d.lines.slice(0, 8).map((l) => (
                  <li key={l.carId}>
                    <Link to="/cars/$carId" params={{ carId: l.carId }} search={{ tab: 'plan' }} className="font-mono text-accent-700 hover:underline">{l.carId}</Link>
                    {l.text.slice(l.carId.length)}
                  </li>
                ))}
                {d.lines.length > 8 && <li className="text-xs text-slate-500">… and {d.lines.length - 8} more cars</li>}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
