import { useMemo, useState } from 'react'
import { Loading } from '@/components/shared/Loading'
import { usePoll } from '@/lib/hooks'
import { api } from '@/services/api'
import { ChainPanel } from './ChainPanel'
import { kindOf } from '@/lib/timeline'
import { TimelineTable } from './TimelineTable'

type Order = 'event' | 'recorded'

/** The car's event log with ordering and filter controls, and the causation chain of the selected event. */
export function CarTimeline({ carId }: { carId: string }) {
  const { data } = usePoll(() => api.timeline(carId), [carId], 10000)
  const [order, setOrder] = useState<Order>('event')
  const [hideEta, setHideEta] = useState(true)
  const [selected, setSelected] = useState<string | null>(null)
  const events = useMemo(() => {
    const list = (data?.events ?? []).filter((e) => !hideEta || e.type !== 'EtaUpdated')
    return order === 'event' ? [...list].sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : a.position - b.position)) : [...list].sort((a, b) => a.position - b.position)
  }, [data, order, hideEta])
  if (!data) return <Loading />
  const counts = data.events.reduce<Record<string, number>>((acc, e) => ({ ...acc, [kindOf(e)]: (acc[kindOf(e)] ?? 0) + 1 }), {})
  const late = data.events.filter((e) => e.late).length
  const ooo = data.events.filter((e) => e.outOfOrder).length
  const upcast = data.events.filter((e) => e.upcastFrom).length
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1">
          <button type="button" className={order === 'event' ? 'tab-active' : 'tab'} onClick={() => setOrder('event')}>By event time</button>
          <button type="button" className={order === 'recorded' ? 'tab-active' : 'tab'} onClick={() => setOrder('recorded')}>By arrival (log position)</button>
          <label className="ml-3 flex items-center gap-1.5 text-sm text-slate-600">
            <input type="checkbox" checked={hideEta} onChange={(e) => setHideEta(e.target.checked)} /> hide ETA updates
          </label>
        </div>
        <div className="text-xs text-slate-500">
          {data.events.length} events: {counts.fact ?? 0} car facts, {counts.train ?? 0} train, {counts.plan ?? 0} plan, {counts.decision ?? 0} decisions · {late} late · {ooo} out of order · {upcast} upcast
        </div>
      </div>
      <div className={`grid gap-4 ${selected ? 'grid-cols-[1fr_360px]' : 'grid-cols-1'}`}>
        <div className="card max-h-[calc(100vh-180px)] overflow-auto">
          <TimelineTable events={events} selected={selected} onSelect={setSelected} />
        </div>
        {selected && <ChainPanel eventId={selected} carId={carId} onClose={() => setSelected(null)} />}
      </div>
    </div>
  )
}
