import { createFileRoute } from '@tanstack/react-router'
import { AlertIcon } from '@/components/icons'
import { ApprovalPanel } from '@/components/run/ApprovalPanel'
import { ArtifactsTable } from '@/components/run/ArtifactsTable'
import { AttentionPanel } from '@/components/run/AttentionPanel'
import { DagView } from '@/components/run/DagView'
import { JobsTable } from '@/components/run/JobsTable'
import { RunHeader } from '@/components/run/RunHeader'
import { WorkflowSource } from '@/components/run/WorkflowSource'
import { EmptyNote, ErrorNote, Loading, Panel } from '@/components/shared/Feedback'
import { usePoll } from '@/lib/use-poll'
import { api } from '@/services/api'

export const Route = createFileRoute('/runs/$runId/')({ component: RunPage })

function RunPage() {
  const { runId } = Route.useParams()
  const { data, error, errorStatus, reload } = usePoll(() => api.run(runId), 1500, [runId])
  if (errorStatus === 404) return <main className="page"><ErrorNote message="This run does not exist, or you do not have access to it." /></main>
  if (!data) return error ? <div className="page"><ErrorNote message={error} /></div> : <Loading />
  const attention = data.jobs.filter((j) => j.status === 'needs_attention')
  const waiting = data.jobs.filter((j) => j.status === 'waiting')
  return (
    <div className="page">
      <RunHeader detail={data} onChanged={reload} />
      {error && <ErrorNote message={`Showing the last known state: ${error}`} />}
      {data.run.error && (
        <section className="rounded-lg border border-rose-300 bg-rose-50 p-4" aria-label="Workflow errors">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-rose-900">
            <AlertIcon className="h-4 w-4" /> The workflow file was rejected ({data.run.error.code})
          </h2>
          <p className="mt-1 text-sm text-rose-900">No jobs were created. Commit {data.run.commitSha.slice(0, 8)} stays pinned, so fix the workflow in a new commit.</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 font-mono text-xs text-rose-900">
            {(data.run.error.details ?? [{ message: data.run.error.message ?? '' }]).map((d, i) => (
              <li key={i}>{d.message}</li>
            ))}
          </ul>
        </section>
      )}
      {attention.map((job) => (
        <AttentionPanel key={job.id} runId={data.run.id} jobId={job.id} jobName={job.name} reason={job.statusReason} canManage={data.canManage} onChanged={reload} />
      ))}
      {waiting.map((job) => (
        <ApprovalPanel key={job.id} jobId={job.id} jobName={job.name} environment={job.environment} reason={job.statusReason} canManage={data.canManage} onChanged={reload} />
      ))}
      {data.jobs.length > 0 && (
        <>
          <Panel title="Job graph" label="Job graph panel">
            <DagView runId={data.run.id} jobs={data.jobs} />
          </Panel>
          <Panel title="Jobs" label="Jobs panel">
            <JobsTable detail={data} onChanged={reload} />
          </Panel>
          <Panel title="Artifacts" label="Artifacts panel" aside={<span className="text-xs text-slate-500">passed to dependents through needs</span>}>
            {data.artifacts.length > 0 ? <ArtifactsTable artifacts={data.artifacts} /> : <div className="p-4"><EmptyNote>This run has no artifacts.</EmptyNote></div>}
          </Panel>
        </>
      )}
      <Panel title="Workflow" label="Workflow panel" aside={<span className="font-mono text-xs text-slate-500">{data.run.workflowPath}</span>}>
        <WorkflowSource runId={data.run.id} />
      </Panel>
    </div>
  )
}
