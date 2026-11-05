import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useRef } from 'react'
import { AlertDrawer } from '@/components/alerts/AlertDrawer'
import { AlertFilters, type AlertFilterState } from '@/components/alerts/AlertFilters'
import { AlertRow } from '@/components/alerts/AlertRow'
import { Empty, ErrorNote, Loading } from '@/components/shared/Loading'
import { PageHeader } from '@/components/shared/PageHeader'
import { useFetch, useTicker } from '@/lib/hooks'
import { api } from '@/services/api'
import { useAuthStore } from '@/stores/auth-store'
import { useClockStore } from '@/stores/clock-store'
import { useLiveStore } from '@/stores/live-store'

interface Search {
  tier?: number
  territory?: string
  status?: 'active' | 'closed' | 'all'
  late?: boolean
  alert?: string
}

export const Route = createFileRoute('/alerts')({
  validateSearch: (s: Record<string, unknown>): Search => ({
    tier: s.tier ? Number(s.tier) : undefined,
    territory: typeof s.territory === 'string' ? s.territory : undefined,
    status: s.status === 'closed' || s.status === 'all' ? s.status : undefined,
    late: s.late === true || s.late === 'true' ? true : undefined,
    alert: typeof s.alert === 'string' ? s.alert : undefined,
  }),
  component: AlertsPage,
})

export function AlertsPage() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: '/alerts' })
  const user = useAuthStore((s) => s.user)
  const revision = useLiveStore((s) => s.revisions.alerts)
  const lastAlertId = useLiveStore((s) => s.lastAlertId)
  const nowMs = useClockStore((s) => s.now)()
  useTicker()
  const filters: AlertFilterState = { tier: search.tier, territory: search.territory, status: search.status ?? 'active', late: search.late }
  const { data, error } = useFetch(() => api.alerts(filters), [filters.tier, filters.territory, filters.status, filters.late, revision])
  const network = useFetch(() => api.network(), []).data
  const seen = useRef(new Set<string>())

  useEffect(() => {
    if (data) useClockStore.getState().update(data.clock)
  }, [data])
  const flashId = lastAlertId && !seen.current.has(`${lastAlertId}:${revision}`) ? lastAlertId : null
  if (flashId) seen.current.add(`${flashId}:${revision}`)

  const setFilters = (next: AlertFilterState) => void navigate({ search: { ...next, status: next.status === 'active' ? undefined : next.status, alert: search.alert } })
  return (
    <div className="flex h-full">
      <div className="page min-w-0 flex-1">
        <PageHeader
          title="Alert queue"
          subtitle={`Trending and fused detector evidence, highest risk first. ${user?.deskId ? `Your desk: ${user.deskId}.` : ''} The detector's own radio alarm is the safety path; this queue adds early warning.`}
        />
        <AlertFilters value={filters} counts={data?.counts ?? {}} network={network} onChange={setFilters} />
        {error && <ErrorNote message={error} />}
        {!data && !error && <Loading />}
        {data && (
          <ul className="card divide-y divide-slate-100 overflow-hidden" aria-label="Alerts">
            {data.alerts.map((a) => (
              <AlertRow key={a.id} alert={a} nowMs={nowMs} selected={a.id === search.alert} flash={a.id === flashId}
                onSelect={() => void navigate({ search: { ...search, alert: a.id } })} />
            ))}
            {data.alerts.length === 0 && <Empty>No alerts match these filters.</Empty>}
          </ul>
        )}
      </div>
      {search.alert && <AlertDrawer alertId={search.alert} onClose={() => void navigate({ search: { ...search, alert: undefined } })} />}
    </div>
  )
}
