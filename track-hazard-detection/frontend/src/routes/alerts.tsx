import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { AlertRow } from '@/components/alerts/AlertRow'
import { Empty, ErrorNote, Loading } from '@/components/shared/Loading'
import { PageHeader } from '@/components/shared/PageHeader'
import { useFetch, useTicker } from '@/lib/hooks'
import { api } from '@/services/api'
import { useAuthStore } from '@/stores/auth-store'
import { useLiveStore } from '@/stores/live-store'

export const Route = createFileRoute('/alerts')({ component: AlertsPage })

export function AlertsPage() {
  const user = useAuthStore((s) => s.user)
  const rev = useLiveStore((s) => s.revisions)
  const now = useTicker(1000)
  const [scope, setScope] = useState<'mine' | 'all'>(user?.role === 'dispatcher' ? 'mine' : 'all')
  const [closed, setClosed] = useState(false)
  const { data, error, reload } = useFetch(() => api.alerts(scope, closed), [scope, closed, rev.alerts, rev.hazards])
  const inspector = user?.role === 'inspector'
  return (
    <div className="page">
      <PageHeader
        title={inspector ? 'My dispatches' : 'Alert queue'}
        subtitle={inspector ? 'Hazards you were dispatched to. Clear them or call a false alarm from the hazard page.' : 'Routed to the dispatcher who owns the territory. Unacknowledged alerts escalate at their deadline (durable timers).'}
        actions={
          <>
            {user?.role === 'dispatcher' && (
              <select className="input w-44" value={scope} onChange={(e) => setScope(e.target.value as 'mine' | 'all')} aria-label="Scope">
                <option value="mine">My desk ({user.deskId})</option>
                <option value="all">All desks</option>
              </select>
            )}
            <label className="flex items-center gap-1.5 text-sm text-slate-600">
              <input type="checkbox" checked={closed} onChange={(e) => setClosed(e.target.checked)} /> include closed
            </label>
          </>
        }
      />
      {error && <ErrorNote message={error} />}
      {!data ? (
        <Loading />
      ) : (
        <ul className="card divide-y divide-slate-100" aria-label="Alerts">
          {data.alerts.length === 0 && <Empty>No alerts. Nothing needs acknowledging.</Empty>}
          {data.alerts.map((a) => (
            <AlertRow key={a.hazardId} alert={a} now={now} canAck={!inspector && (user?.role === 'admin' || a.deskId === user?.deskId)} onDone={reload} />
          ))}
        </ul>
      )}
    </div>
  )
}
