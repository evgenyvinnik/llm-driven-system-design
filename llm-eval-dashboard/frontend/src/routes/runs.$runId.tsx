import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { AggregateCards } from '@/components/runs/AggregateCards'
import { CaseTable } from '@/components/runs/CaseTable'
import { ProgressPanel } from '@/components/runs/ProgressPanel'
import { RescoreDialog } from '@/components/runs/RescoreDialog'
import { RunHeader } from '@/components/runs/RunHeader'
import { SamePinsTable } from '@/components/runs/SamePinsTable'
import { ErrorNote, Loading } from '@/components/shared/Loading'
import { usePoll } from '@/lib/use-poll'
import { api } from '@/services/api'

export const Route = createFileRoute('/runs/$runId')({ component: RunPage })

function RunPage() {
  const { runId } = Route.useParams()
  const detail = usePoll(() => api.run(runId), 1500, [runId])
  const cases = usePoll(() => api.runCases(runId), 3000, [runId])
  const [picked, setPicked] = useState<string | null>(null)
  const [rescoring, setRescoring] = useState(false)

  if (detail.error && !detail.data) return <div className="page"><ErrorNote message={detail.error} /></div>
  if (!detail.data) return <div className="page"><Loading /></div>
  const d = detail.data
  const selected = picked && d.scorers.some((s) => s.scorerVersionId === picked) ? picked : (d.scorers.find((s) => s.kind !== 'human')?.scorerVersionId ?? d.scorers[0]?.scorerVersionId ?? null)
  const reload = () => {
    detail.reload()
    cases.reload()
  }

  return (
    <div className="page max-w-7xl">
      <RunHeader detail={d} onChanged={reload} onRescore={() => setRescoring(true)} />
      <ProgressPanel detail={d} />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-4">
        <div className="xl:col-span-3">
          <AggregateCards scorers={d.scorers} selected={selected} onSelect={setPicked} />
        </div>
        <SamePinsTable detail={d} scorerVersionId={selected} />
      </div>
      <div>
        <h2 className="mb-2 text-sm font-semibold text-slate-700">Per case ({d.run.dataset.caseCount} cases × {d.run.samplesPerCase} samples) · scored by {d.scorers.find((s) => s.scorerVersionId === selected)?.name ?? '—'}</h2>
        {cases.data && selected ? <CaseTable runId={runId} cases={cases.data.cases} scorers={d.scorers} svId={selected} /> : <Loading label="Loading cases…" />}
      </div>
      {rescoring && <RescoreDialog runId={runId} attached={d.scorers} modelCalls={d.usage.modelCalls} onClose={() => setRescoring(false)} onDone={reload} />}
    </div>
  )
}
