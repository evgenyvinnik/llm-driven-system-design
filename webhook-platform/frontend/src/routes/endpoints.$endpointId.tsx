import { Link, createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { DeliveriesTable, DeliveryFilter } from '@/components/deliveries/DeliveriesTable'
import { EndpointHeader } from '@/components/endpoints/EndpointHeader'
import { EndpointSettings } from '@/components/endpoints/EndpointSettings'
import { HealthTiles } from '@/components/endpoints/HealthTiles'
import { ReplayCard } from '@/components/endpoints/ReplayCard'
import { SecretCard } from '@/components/endpoints/SecretCard'
import { ErrorNote, Loading } from '@/components/shared/Loading'
import { usePoll } from '@/lib/use-poll'
import { api } from '@/services/api'

export const Route = createFileRoute('/endpoints/$endpointId')({ component: EndpointPage })

function EndpointPage() {
  const { endpointId } = Route.useParams()
  const [filter, setFilter] = useState('')
  const ep = usePoll(() => api.endpoint(endpointId), 2000, [endpointId])
  const deliveries = usePoll(() => api.endpointDeliveries(endpointId, filter || undefined), 2000, [endpointId, filter])
  const refresh = () => {
    ep.reload()
    deliveries.reload()
  }

  if (ep.error) return <div className="page"><ErrorNote message={ep.error} /></div>
  if (!ep.data) return <Loading />
  const e = ep.data.endpoint
  return (
    <div className="page">
      <Link to="/endpoints" className="text-xs text-slate-500 hover:text-slate-800">← Endpoints</Link>
      <EndpointHeader endpoint={e} onChange={refresh} />
      <HealthTiles endpoint={e} />
      <div className="grid gap-4 lg:grid-cols-3">
        <EndpointSettings key={`${e.id}-${e.eventTypes.join()}-${e.maxConcurrency}`} endpoint={e} onSaved={refresh} />
        <SecretCard endpoint={e} onRotated={refresh} />
        <ReplayCard endpoint={e} onReplayed={refresh} />
      </div>
      <section className="card">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-900">Delivery log</h2>
          <DeliveryFilter value={filter} onChange={setFilter} />
        </div>
        {!deliveries.data ? <Loading /> : <DeliveriesTable deliveries={deliveries.data.deliveries} />}
      </section>
    </div>
  )
}
