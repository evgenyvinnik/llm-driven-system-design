import { ClockIcon } from '@/components/icons'
import type { Job } from '@/types'

/** Time remaining, from the server's own timestamp. A rough number for people: expiry is judged by the database clock. */
export function LeaseBadge({ job }: { job: Job }) {
  if (job.status !== 'running' || !job.leaseExpiresAt) return null
  const seconds = Math.max(0, (new Date(job.leaseExpiresAt).getTime() - Date.now()) / 1000)
  return (
    <span className="chip bg-accent-50 text-accent-700" aria-label="Lease">
      <ClockIcon className="h-3 w-3" /> lease held by {job.runnerName}, {seconds.toFixed(1)} s left, token {job.fencingToken}
      {job.cancelRequested ? ', cancelling' : ''}
    </span>
  )
}
