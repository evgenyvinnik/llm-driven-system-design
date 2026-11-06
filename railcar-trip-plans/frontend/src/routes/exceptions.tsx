import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { ExceptionTable } from '@/components/exceptions/ExceptionTable'
import { Empty, ErrorNote, Loading, PageHeader, StatTile } from '@/components/shared/Loading'
import { label, useNow } from '@/lib/format'
import { usePoll } from '@/lib/hooks'
import { api } from '@/services/api'
import { useAuthStore } from '@/stores/auth-store'

export const Route = createFileRoute('/exceptions')({ component: Exceptions })

const TYPES = ['missed_connection', 'train_cancelled', 'no_capacity', 'bad_order', 'dwell_exceeded'] as const

export function Exceptions() {
  const now = useNow()
  const role = useAuthStore((s) => s.user!.role)
  const [status, setStatus] = useState<'open' | 'resolved' | 'all'>('open')
  const [type, setType] = useState('')
  const { data, error, refresh } = usePoll(() => api.exceptions(status, type || undefined), [status, type])
  const count = (t: string, s: string) => data?.counts.find((c) => c.type === t && c.status === s)?.n ?? 0
  const openTotal = TYPES.reduce((n, t) => n + count(t, 'open'), 0)

  return (
    <div className="page">
      <PageHeader
        title="Exceptions board"
        subtitle="Opened and resolved by the exceptions consumer from events: missed connections (including ones predicted before the train left), cancelled trains, replans that found no capacity, bad orders, and cars dwelling past their yard's p90."
      />
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-6">
        <StatTile label="Open" value={openTotal} tone={openTotal ? 'warn' : 'good'} />
        {TYPES.map((t) => (
          <button key={t} type="button" className="text-left" onClick={() => setType(type === t ? '' : t)}>
            <StatTile label={label(t)} value={count(t, 'open')} hint={`${count(t, 'resolved')} resolved${type === t ? ' · filtered' : ''}`} tone={t === 'no_capacity' && count(t, 'open') ? 'bad' : 'default'} />
          </button>
        ))}
      </div>
      <div className="mb-3 flex gap-1">
        {(['open', 'resolved', 'all'] as const).map((s) => (
          <button key={s} type="button" className={status === s ? 'tab-active' : 'tab'} onClick={() => setStatus(s)}>{s}</button>
        ))}
        {type && <button type="button" className="tab" onClick={() => setType('')}>clear type: {label(type)}</button>}
      </div>
      {error && <ErrorNote message={error} />}
      <div className="card overflow-hidden">
        {!data ? <Loading /> : data.exceptions.length === 0 ? <Empty>Nothing here.</Empty> : <ExceptionTable rows={data.exceptions} now={now} canAct={role !== 'shipper'} onChanged={() => void refresh()} />}
      </div>
    </div>
  )
}
