import { useState } from 'react'
import { ShieldIcon } from '@/components/icons'
import { ErrorNote } from '@/components/shared/Feedback'
import { api } from '@/services/api'

export function ApprovalPanel({ jobId, jobName, environment, reason, canManage, onChanged }: { jobId: string; jobName: string; environment: string | null; reason: string | null; canManage: boolean; onChanged: () => void }) {
  const [comment, setComment] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function decide(decision: 'approved' | 'rejected') {
    setError(null)
    try {
      await api.decide(jobId, decision, comment || null)
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not record the decision')
    }
  }

  return (
    <section className="rounded-lg border border-violet-300 bg-violet-50 p-4" aria-label={`Approval: ${jobName}`} data-approval="true">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-violet-900">
        <ShieldIcon className="h-4 w-4" /> {jobName} is waiting to enter {environment}
      </h2>
      <p className="mt-1 text-sm text-violet-900">{reason}. Its secrets have not been released, and no runner can claim it.</p>
      {canManage ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input className="input max-w-sm" placeholder="Comment (optional)" value={comment} onChange={(e) => setComment(e.target.value)} aria-label="Approval comment" />
          <button type="button" className="btn-primary" onClick={() => void decide('approved')}>
            Approve
          </button>
          <button type="button" className="btn-danger" onClick={() => void decide('rejected')}>
            Reject
          </button>
        </div>
      ) : (
        <p className="mt-2 text-xs text-violet-900">A maintainer has to approve this. You have read-only access.</p>
      )}
      {error && (
        <div className="mt-2">
          <ErrorNote message={error} />
        </div>
      )}
    </section>
  )
}
