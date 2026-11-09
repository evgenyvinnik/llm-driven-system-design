import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { EscalationCard } from '@/components/escalations/EscalationCard'
import { Empty, ErrorNote, Loading } from '@/components/shared/Loading'
import { usePoll } from '@/lib/use-poll'
import { api } from '@/services/api'

export const Route = createFileRoute('/escalations')({ component: Escalations })

const FILTERS = [
  { id: 'active', label: 'Needs a person' },
  { id: 'decided', label: 'Decided' },
  { id: 'invalidated', label: 'Out of date' },
  { id: 'all', label: 'All' },
]

function Escalations() {
  const [status, setStatus] = useState('active')
  const [actionError, setActionError] = useState<string | null>(null)
  const { data, error, loading, reload } = usePoll(() => api.escalations({ status }), 2500, [status])
  return (
    <div className="page">
      <div>
        <h1 className="h1">Escalation queue</h1>
        <p className="text-sm text-slate-500">Anything uncertain or failed lands here: a refused rule, a risky opinion, a model outage, missing CI. A decision is recorded against one SHA, and a new push invalidates it.</p>
      </div>
      <div className="flex gap-1" role="tablist" aria-label="Queue filter">
        {FILTERS.map((f) => (
          <button key={f.id} type="button" role="tab" aria-selected={status === f.id} className={status === f.id ? 'btn-primary' : 'btn-secondary'} onClick={() => setStatus(f.id)}>{f.label}</button>
        ))}
      </div>
      {actionError && <ErrorNote message={actionError} />}
      {error && <ErrorNote message={error} />}
      {loading && !data ? <Loading /> : data && data.escalations.length > 0 ? (
        <div className="space-y-3" aria-label="Escalations">
          {data.escalations.map((e) => <EscalationCard key={e.id} item={e} onChange={reload} onError={setActionError} />)}
        </div>
      ) : <Empty>Nothing here.</Empty>}
    </div>
  )
}
