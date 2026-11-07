import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { CarTable } from '@/components/cars/CarTable'
import { Empty, ErrorNote, Loading, PageHeader, StatTile } from '@/components/shared/Loading'
import { usePoll } from '@/lib/hooks'
import { useNow } from '@/lib/format'
import { api } from '@/services/api'
import { useAuthStore } from '@/stores/auth-store'

export const Route = createFileRoute('/cars/')({ component: Cars })

const STATUSES = ['', 'in_transit', 'at_yard', 'bad_ordered', 'off_network', 'delivered']
const PLAN_STATUSES = ['', 'on_plan', 'replanned', 'missed_connection', 'complete']

export function Cars() {
  const user = useAuthStore((s) => s.user)!
  const now = useNow()
  const [shipper, setShipper] = useState('')
  const [status, setStatus] = useState('')
  const [planStatus, setPlanStatus] = useState('')
  const [q, setQ] = useState('')
  const { data, error } = usePoll(() => api.cars({ shipper, status, planStatus, q }), [shipper, status, planStatus, q])
  const isShipper = user.role === 'shipper'
  const c = data?.counts ?? {}
  const p = data?.planCounts ?? {}

  return (
    <div className="page">
      <PageHeader
        title={isShipper ? `${user.shipperName}: my cars` : 'All cars'}
        subtitle="Where every loaded car is against its trip plan, and when it will be placed. ETAs come from yard dwell history, shown as a range; the dashed line is the original plan."
      />
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-5">
        <StatTile label="In transit" value={c.in_transit ?? 0} />
        <StatTile label="At a yard" value={(c.at_yard ?? 0) + (c.bad_ordered ?? 0)} hint={c.bad_ordered ? `${c.bad_ordered} bad-ordered` : undefined} />
        <StatTile label="On a foreign road" value={c.off_network ?? 0} hint="after interchange" />
        <StatTile label="Replanned" value={p.replanned ?? 0} tone={(p.replanned ?? 0) > 0 ? 'warn' : 'default'} hint={p.missed_connection ? `${p.missed_connection} awaiting a new plan` : 'new plan version issued'} />
        <StatTile label="Delivered" value={c.delivered ?? 0} tone="good" />
      </div>
      <div className="mb-3 flex flex-wrap items-end gap-3">
        {!isShipper && (
          <div>
            <label className="label" htmlFor="shipper">Shipper</label>
            <select id="shipper" className="input w-56" value={shipper} onChange={(e) => setShipper(e.target.value)}>
              <option value="">All shippers</option>
              {data?.shippers.map((s) => <option key={s.shipper_id} value={s.shipper_id}>{s.name}</option>)}
            </select>
          </div>
        )}
        <div>
          <label className="label" htmlFor="status">Status</label>
          <select id="status" className="input w-40" value={status} onChange={(e) => setStatus(e.target.value)}>
            {STATUSES.map((s) => <option key={s} value={s}>{s ? s.replace(/_/g, ' ') : 'Any status'}</option>)}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="plan">Plan</label>
          <select id="plan" className="input w-44" value={planStatus} onChange={(e) => setPlanStatus(e.target.value)}>
            {PLAN_STATUSES.map((s) => <option key={s} value={s}>{s ? s.replace(/_/g, ' ') : 'Any plan status'}</option>)}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="q">Car</label>
          <input id="q" className="input w-40" placeholder="HPSX104…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      {error && <ErrorNote message={error} />}
      <div className="card overflow-hidden">
        {!data ? <Loading /> : data.cars.length === 0 ? <Empty>No cars match.</Empty> : <CarTable cars={data.cars} now={now} showShipper={!isShipper} />}
      </div>
    </div>
  )
}
