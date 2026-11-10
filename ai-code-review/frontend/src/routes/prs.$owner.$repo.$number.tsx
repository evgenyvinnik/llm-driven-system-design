import { Link, createFileRoute } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { DecisionBanner } from '@/components/prs/DecisionBanner'
import { DiffViewer } from '@/components/prs/DiffViewer'
import { GateChecklist } from '@/components/prs/GateChecklist'
import { ModelPanel } from '@/components/prs/ModelPanel'
import { HostPanel, UsageCard } from '@/components/prs/RunFacts'
import { Timeline } from '@/components/prs/Timeline'
import { ToolRequests } from '@/components/prs/ToolRequests'
import { Chip, ModeChip, OutcomeChip, Sha } from '@/components/shared/Chips'
import { ErrorNote, Loading } from '@/components/shared/Loading'
import { usePoll } from '@/lib/use-poll'
import { api } from '@/services/api'
import { canAdmin, useAuthStore } from '@/stores/auth-store'

export const Route = createFileRoute('/prs/$owner/$repo/$number')({ component: PrPage })

function PrPage() {
  const { owner, repo, number } = Route.useParams()
  const user = useAuthStore((s) => s.user)
  const { data, error, reload } = usePoll(() => api.pr(owner, repo, number), 2500, [owner, repo, number])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const decision = useMemo(() => {
    if (!data) return null
    return data.decisions.find((d) => d.id === selectedId) ?? data.decisions.find((d) => d.state === 'active') ?? data.decisions[0] ?? null
  }, [data, selectedId])

  if (error && !data) return <div className="page"><ErrorNote message={error} /></div>
  if (!data) return <Loading />

  const sha = decision?.headSha ?? data.pr.headSha
  const run = data.runs.find((r) => r.kind === 'full' && r.headSha === sha) ?? data.runs.find((r) => r.kind === 'full')
  const open = data.escalations.find((e) => e.status === 'open' || e.status === 'claimed')

  async function act(fn: () => Promise<unknown>) {
    setActionError(null)
    try {
      await fn()
      reload()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'That did not work')
    }
  }

  return (
    <div className="page !max-w-7xl">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs text-slate-500"><Link to="/prs" className="hover:underline">Pull requests</Link> / {data.repo.fullName}</div>
          <h1 className="h1">#{data.pr.number} {data.pr.title}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-600">
            <span>by {data.pr.author}</span> <span>→ {data.pr.baseRef}</span> <span>head <Sha sha={data.pr.headSha} /></span>
            <ModeChip mode={data.repo.mode} killSwitch={data.repo.killSwitch} />
            {data.pr.state !== 'open' && <Chip>{data.pr.state}</Chip>}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {open && <Link to="/escalations" className="btn-secondary">In the queue: {open.status}</Link>}
          {canAdmin(user) && <button type="button" className="btn-secondary" onClick={() => void act(() => api.rerun(owner, repo, data.pr.number))}>Re-run review</button>}
          {decision?.outcome === 'auto_approved' && !decision.falseApprovalReportedAt && (
            <button type="button" className="btn-danger" onClick={() => void act(() => api.reportFalseApproval(decision.id, `Reported by ${user?.username} from the console`))}>Report dangerous false approval</button>
          )}
        </div>
      </div>
      {actionError && <ErrorNote message={actionError} />}
      {decision ? <DecisionBanner decision={decision} model={run?.parsedOutput ?? null} /> : <div className="card p-4 text-sm text-slate-500">Review in progress: {data.runs[0]?.status ?? 'queued'}.</div>}
      {decision?.falseApprovalReportedAt && <ErrorNote message={`Reported as a dangerous false approval by ${decision.falseApprovalReportedBy}. The repository was demoted to observe.`} />}
      {data.decisions.length > 1 && (
        <div className="card p-3" aria-label="Decision history">
          <h2 className="panel-title mb-2">Decisions on this pull request</h2>
          <div className="flex flex-wrap gap-2">
            {data.decisions.map((d) => (
              <button key={d.id} type="button" onClick={() => setSelectedId(d.id)} className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs ${d.id === decision?.id ? 'border-accent-500 bg-accent-50' : 'border-slate-200 bg-white hover:bg-slate-50'}`}>
                <Sha sha={d.headSha} /> <OutcomeChip outcome={d.outcome} invalidated={d.state !== 'active'} />
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <GateChecklist gate={decision?.gate ?? null} sha={sha} />
          <ModelPanel run={run} />
          <ToolRequests run={run} />
          <DiffViewer files={run?.files} sha={sha} />
        </div>
        <div className="space-y-5">
          <HostPanel reviews={data.hostReviews} blockers={data.mergeBlockers} intents={data.intents} />
          <UsageCard run={run} />
          <Timeline entries={data.timeline} />
        </div>
      </div>
    </div>
  )
}
