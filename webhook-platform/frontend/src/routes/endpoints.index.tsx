import { createFileRoute } from '@tanstack/react-router'
import { CreateEndpointForm } from '@/components/endpoints/CreateEndpointForm'
import { EndpointsTable } from '@/components/endpoints/EndpointsTable'
import { ProducerHint } from '@/components/endpoints/ProducerHint'
import { ErrorNote, Loading } from '@/components/shared/Loading'
import { usePoll } from '@/lib/use-poll'
import { api } from '@/services/api'

export const Route = createFileRoute('/endpoints/')({ component: EndpointsPage })

function EndpointsPage() {
  const { data, error, reload } = usePoll(() => api.endpoints(), 3000)
  const receiverUrl = data?.endpoints[0]?.url.replace(/\/hooks\/.*$/, '') ?? 'http://localhost:3300'
  return (
    <div className="page">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="h1">Endpoints</h1>
          <p className="mt-1 text-sm text-slate-500">
            Each endpoint gets its own delivery queue position and its own in-flight limit, so one slow receiver can't hold up the others.
          </p>
        </div>
        <CreateEndpointForm receiverUrl={receiverUrl} onCreated={reload} />
      </div>
      {error && <ErrorNote message={error} />}
      {!data ? <Loading /> : <EndpointsTable endpoints={data.endpoints} />}
      <ProducerHint />
    </div>
  )
}
