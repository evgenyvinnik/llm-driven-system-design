import { Link } from '@tanstack/react-router'
import { GitBranchIcon, GitForkIcon, ShieldIcon } from '@/components/icons'
import { StatusChip } from '@/components/shared/StatusChip'
import { duration, shortSha, timeAgo } from '@/lib/format'
import type { RunDetail } from '@/types'
import { RunActions } from './RunActions'

export function RunHeader({ detail, onChanged }: { detail: RunDetail; onChanged: () => void }) {
  const { run, trigger } = detail
  return (
    <header className="space-y-3">
      <div className="text-sm text-slate-500">
        <Link to="/repos/$repoId" params={{ repoId: run.repoId }} className="link">
          {run.repositoryName}
        </Link>{' '}
        / run #{run.number}
      </div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="h1">{run.commitMessage}</h1>
          <StatusChip status={run.status} />
          {run.runAttempt > 1 && <span className="chip bg-slate-200 text-slate-700">run attempt {run.runAttempt}</span>}
          {run.isFork && (
            <span className="chip bg-orange-100 text-orange-800">
              <GitForkIcon className="h-3 w-3" /> from fork {run.headRepo}
            </span>
          )}
        </div>
        <RunActions detail={detail} onChanged={onChanged} />
      </div>
      <dl className="card grid gap-x-6 gap-y-2 p-3 text-xs md:grid-cols-4" aria-label="Pins">
        <div>
          <dt className="label !mb-0.5">Pinned commit</dt>
          <dd className="flex items-center gap-1 font-mono" title={run.commitSha}>
            <GitBranchIcon className="h-3 w-3 text-slate-400" /> {shortSha(run.commitSha)}
          </dd>
        </div>
        <div>
          <dt className="label !mb-0.5">Pinned workflow</dt>
          <dd className="font-mono" title={run.workflowSha}>
            {run.workflowPath} @ {shortSha(run.workflowSha)}
          </dd>
        </div>
        <div>
          <dt className="label !mb-0.5">Trigger</dt>
          <dd>
            {run.eventType === 'pull_request' ? `pull request #${run.prNumber}` : `push to ${run.branch}`} by {run.sender}
          </dd>
        </div>
        <div>
          <dt className="label !mb-0.5">Delivery</dt>
          <dd className="truncate" title={trigger?.deliveryId}>
            <span className="font-mono">{trigger?.deliveryId.slice(0, 18)}</span>
            {trigger && trigger.redeliveries > 0 && <span className="ml-1 font-medium text-accent-700">received {trigger.redeliveries + 1}×, one run</span>}
          </dd>
        </div>
        <div>
          <dt className="label !mb-0.5">Started</dt>
          <dd>{timeAgo(run.createdAt)}</dd>
        </div>
        <div>
          <dt className="label !mb-0.5">Duration</dt>
          <dd className="num">{duration(run.startedAt, run.finishedAt)}</dd>
        </div>
        {run.cancelledBy && (
          <div>
            <dt className="label !mb-0.5">Cancelled by</dt>
            <dd>{run.cancelledBy}</dd>
          </div>
        )}
      </dl>
      {run.isFork && (
        <div className="flex items-start gap-2 rounded-md border border-orange-200 bg-orange-50 px-3 py-2 text-sm text-orange-900" aria-label="Fork notice">
          <ShieldIcon className="mt-0.5 h-4 w-4 shrink-0" />
          <span>This run executes code from a fork, which no maintainer has reviewed. It receives no secrets and cannot enter a protected environment. The claim path enforces this; what you see here only reports it.</span>
        </div>
      )}
    </header>
  )
}
