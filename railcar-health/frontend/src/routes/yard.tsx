import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { CloudOffIcon, RefreshIcon } from '@/components/icons'
import { Empty, ErrorNote, Loading } from '@/components/shared/Loading'
import { PageHeader } from '@/components/shared/PageHeader'
import { HoldsPanel } from '@/components/yard/HoldsPanel'
import { OutboundCheck } from '@/components/yard/OutboundCheck'
import { WorkOrderCard } from '@/components/yard/WorkOrderCard'
import { useFetch, useTicker } from '@/lib/hooks'
import { api } from '@/services/api'
import { flushQueue, loadQueue } from '@/services/offline-queue'
import { useAuthStore } from '@/stores/auth-store'
import { useClockStore } from '@/stores/clock-store'
import { useLiveStore } from '@/stores/live-store'

type Tab = 'open' | 'completed'

export const Route = createFileRoute('/yard')({
  validateSearch: (s: Record<string, unknown>): { yard?: string; tab?: Tab } => ({
    yard: typeof s.yard === 'string' ? s.yard : undefined,
    tab: s.tab === 'completed' ? 'completed' : undefined,
  }),
  component: YardPage,
})

export function YardPage() {
  const user = useAuthStore((s) => s.user)
  const search = Route.useSearch()
  const navigate = useNavigate({ from: '/yard' })
  const yardId = user?.role === 'yard' ? user.yardId! : (search.yard ?? 'CDJ')
  const tab: Tab = search.tab ?? 'open'
  const revision = useLiveStore((s) => s.revisions.yard)
  const [notice, setNotice] = useState<string | null>(null)
  const [pending, setPending] = useState(loadQueue().length)
  const yards = useFetch(() => api.yards(), [revision])
  const orders = useFetch(() => api.workOrders(yardId, tab), [yardId, tab, revision])
  const holds = useFetch(() => api.holds(yardId), [yardId, revision])
  const nowMs = useClockStore((s) => s.now)()
  useTicker()

  useEffect(() => {
    if (orders.data) useClockStore.getState().update(orders.data.clock)
  }, [orders.data])
  // Resend findings saved while offline: on load, when the browser comes back online, and every 10 s.
  useEffect(() => {
    const sync = () => void flushQueue().then(({ sent, remaining }) => {
      setPending(remaining)
      if (sent > 0) {
        setNotice(`${sent} offline finding${sent > 1 ? 's' : ''} synced.`)
        useLiveStore.getState().bump(['yard', 'alerts'])
      }
    })
    sync()
    window.addEventListener('online', sync)
    const id = setInterval(sync, 10_000)
    return () => {
      window.removeEventListener('online', sync)
      clearInterval(id)
    }
  }, [])

  const yard = yards.data?.yards.find((y) => y.id === yardId)
  const changed = (message?: string) => {
    setNotice(message ?? null)
    setPending(loadQueue().length)
    orders.reload()
    holds.reload()
  }
  const heldCars = (holds.data?.holds ?? []).filter((h) => h.status !== 'released').map((h) => h.carId)
  return (
    <div className="page">
      <PageHeader
        title={`${yard?.name ?? yardId} — inspection queue`}
        subtitle="Cars flagged MEDIUM or higher are held here until a car inspector records a finding. Findings close the alert and are the labels that tune thresholds."
        actions={user?.role === 'admin' && (
          <select className="input w-auto" aria-label="Yard" value={yardId} onChange={(e) => void navigate({ search: { yard: e.target.value, tab: search.tab } })}>
            {yards.data?.yards.map((y) => <option key={y.id} value={y.id}>{y.name}</option>)}
          </select>
        )}
      />
      {pending > 0 && (
        <p className="mb-3 flex items-center gap-2 rounded-md bg-violet-50 px-3 py-2 text-sm text-violet-800">
          <CloudOffIcon className="h-4 w-4" /> {pending} finding{pending > 1 ? 's' : ''} saved on this device, waiting to sync.
          <button type="button" className="btn-ghost ml-auto py-0.5" onClick={() => void flushQueue().then((r) => changed(r.sent ? `${r.sent} synced.` : undefined))}><RefreshIcon className="h-3.5 w-3.5" /> Retry now</button>
        </p>
      )}
      {notice && <p className="mb-3 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{notice}</p>}
      <div className="grid grid-cols-3 gap-4">
        <div className="col-span-2">
          <div className="mb-3 flex gap-1.5">
            <button type="button" className={tab === 'open' ? 'btn-primary' : 'btn-secondary'} onClick={() => void navigate({ search: { yard: search.yard } })}>To inspect {yard?.openWork !== undefined ? `(${yard.openWork})` : ''}</button>
            <button type="button" className={tab === 'completed' ? 'btn-primary' : 'btn-secondary'} onClick={() => void navigate({ search: { yard: search.yard, tab: 'completed' } })}>Completed</button>
          </div>
          {orders.error && <ErrorNote message={orders.error} />}
          {!orders.data ? <Loading /> : (
            <ul className="space-y-3" aria-label="Work orders">
              {orders.data.workOrders.map((w) => <WorkOrderCard key={w.id} workOrder={w} nowMs={nowMs} onChanged={changed} />)}
              {orders.data.workOrders.length === 0 && <li className="card"><Empty>{tab === 'open' ? 'Nothing to inspect right now.' : 'No completed inspections yet.'}</Empty></li>}
            </ul>
          )}
        </div>
        <div className="space-y-4">
          <section className="card overflow-hidden">
            <h2 className="border-b border-slate-100 px-4 py-2.5 text-sm font-semibold text-slate-900">Car holds</h2>
            {holds.data ? <HoldsPanel holds={holds.data.holds.slice(0, 12)} nowMs={nowMs} /> : <Loading />}
          </section>
          <section className="card p-4">
            <h2 className="mb-2 text-sm font-semibold text-slate-900">Outbound build check</h2>
            <OutboundCheck key={heldCars.join()} yardId={yardId} suggestion={[...heldCars.slice(0, 1), 'NRLX 100001'].join('\n')} />
          </section>
        </div>
      </div>
    </div>
  )
}
