import { createFileRoute, Link } from '@tanstack/react-router'
import { ActionPanel } from '@/components/hazard/ActionPanel'
import { CorrelationChart } from '@/components/hazard/CorrelationChart'
import { EvidenceTable } from '@/components/hazard/EvidenceTable'
import { HazardHeader } from '@/components/hazard/HazardHeader'
import { Notifications } from '@/components/hazard/Notifications'
import { ResponseState } from '@/components/hazard/ResponseState'
import { Timeline } from '@/components/hazard/Timeline'
import { ChevronRightIcon } from '@/components/icons'
import { ErrorNote, Loading } from '@/components/shared/Loading'
import { useFetch, useTicker } from '@/lib/hooks'
import { api } from '@/services/api'
import { useLiveStore } from '@/stores/live-store'

export const Route = createFileRoute('/hazards/$hazardId')({ component: HazardPage })

export function HazardPage() {
  const { hazardId } = Route.useParams()
  const rev = useLiveStore((s) => s.revisions)
  const now = useTicker(1000)
  const { data, error, reload } = useFetch(() => api.hazard(hazardId), [hazardId, rev.hazards, rev.alerts, rev.restrictions])
  if (error && !data) return <div className="page"><ErrorNote message={error} /></div>
  if (!data) return <Loading />
  const h = data.hazard
  return (
    <div className="page space-y-4">
      <nav className="flex items-center gap-1 text-xs text-slate-500">
        <Link to="/board" className="hover:text-slate-800">Operator board</Link>
        <ChevronRightIcon className="h-3 w-3" />
        <span>{h.code}</span>
      </nav>
      <HazardHeader hazard={h} />
      <div className="grid gap-4 xl:grid-cols-2">
        <section className="card p-4">
          <h2 className="panel-title mb-3">Response</h2>
          <ResponseState hazard={h} approaching={data.approachingTrains} now={now} />
          <div className="mt-4 border-t border-slate-100 pt-4">
            <ActionPanel detail={data} onDone={reload} />
          </div>
        </section>
        <section className="card p-4">
          <h2 className="panel-title mb-1">Correlation evidence</h2>
          <p className="mb-2 text-xs text-slate-500">
            {h.evidence.length} sensor reports joined into one hazard; nearby reports that did not join are hollow.
          </p>
          <CorrelationChart hazard={h} evidence={data.evidence} nearby={data.nearbyEvidence} window={data.window} />
        </section>
      </div>
      {data.evidence.length + data.nearbyEvidence.length > 0 && (
        <section className="card">
          <h2 className="panel-title border-b border-slate-100 px-4 py-2.5">Evidence (edge events after upcasting)</h2>
          <EvidenceTable rows={[...data.evidence, ...data.nearbyEvidence]} hazardId={h.hazardId} />
        </section>
      )}
      <section className="card">
        <h2 className="panel-title border-b border-slate-100 px-4 py-2.5">
          Event timeline · stream hazard-{h.hazardId.slice(0, 8)}… · {data.timeline.length} events
        </h2>
        <div className="overflow-x-auto">
          <Timeline events={data.timeline} />
        </div>
      </section>
      <section className="card">
        <h2 className="panel-title border-b border-slate-100 px-4 py-2.5">Notifications (simulated)</h2>
        <Notifications rows={data.notifications} />
      </section>
    </div>
  )
}
