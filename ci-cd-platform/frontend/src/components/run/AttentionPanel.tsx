import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { AlertIcon } from '@/components/icons'
import { ErrorNote } from '@/components/shared/Feedback'
import { Modal } from '@/components/shared/Modal'
import { api } from '@/services/api'

interface Props {
  runId: string
  jobId: string
  jobName: string
  reason: string | null
  canManage: boolean
  lateReport?: { conclusion: string; reason: string | null } | null
  onChanged: () => void
}

/** The heart of the design, in the UI: the platform does not know, says so, and asks. */
export function AttentionPanel({ runId, jobId, jobName, reason, canManage, lateReport, onChanged }: Props) {
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [confirmingRetry, setConfirmingRetry] = useState(false)

  async function decide(decision: 'succeeded' | 'failed' | 'retry', confirmRetry = false) {
    setError(null)
    try {
      await api.resolve(jobId, decision, note || null, confirmRetry)
      setConfirmingRetry(false)
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not record the decision')
    }
  }

  return (
    <section className="rounded-lg border-2 border-amber-400 bg-amber-50 p-4" aria-label={`Attention: ${jobName}`} data-attention="true">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-amber-900">
        <AlertIcon className="h-4 w-4" /> Outcome unknown:{' '}
        <Link to="/runs/$runId/jobs/$jobId" params={{ runId, jobId }} className="underline">
          {jobName}
        </Link>
      </h2>
      <p className="mt-1 text-sm text-amber-900">{reason}</p>
      {lateReport && (
        <p className="mt-2 rounded border border-amber-300 bg-white/60 px-2 py-1 text-xs text-amber-900">
          The lost runner later reported <strong>{lateReport.conclusion}</strong>
          {lateReport.reason ? ` (${lateReport.reason})` : ''}. That report was rejected as truth, because it no longer held the lease, but it is evidence for your decision.
        </p>
      )}
      {canManage ? (
        <div className="mt-3 space-y-2">
          <p className="text-xs text-amber-900">Check the deployment target, then record what actually happened. Nothing downstream moves until you do.</p>
          <input className="input" placeholder="What you checked (kept with the decision)" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Decision note" />
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-primary" onClick={() => void decide('succeeded')}>
              It succeeded: continue downstream
            </button>
            <button type="button" className="btn-danger" onClick={() => void decide('failed')}>
              It failed: skip downstream
            </button>
            <button type="button" className="btn-secondary" onClick={() => setConfirmingRetry(true)}>
              Safe to run again: retry
            </button>
          </div>
        </div>
      ) : (
        <p className="mt-2 text-xs text-amber-900">A maintainer has to decide. You have read-only access.</p>
      )}
      {error && (
        <div className="mt-2">
          <ErrorNote message={error} />
        </div>
      )}
      {confirmingRetry && (
        <Modal title={`Run "${jobName}" again?`} onClose={() => setConfirmingRetry(false)}>
          <p>This executes the non-idempotent step a second time. If the first run took effect, this may do so again. Only continue if you have checked that it is safe.</p>
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-secondary" onClick={() => setConfirmingRetry(false)}>
              Go back
            </button>
            <button type="button" className="btn-warning" onClick={() => void decide('retry', true)}>
              I checked: retry it
            </button>
          </div>
        </Modal>
      )}
    </section>
  )
}
