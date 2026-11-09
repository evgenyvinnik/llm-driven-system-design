import { AlertIcon } from '@/components/icons'
import { Modal } from '@/components/shared/Modal'

export interface UnsafeJob {
  key: string
  name: string
  steps: string[]
}

/** Shown when the server answers CONFIRM_REQUIRED: the list comes from the server, not from what the screen guessed. */
export function RerunConfirm({ jobs, onConfirm, onClose }: { jobs: UnsafeJob[]; onConfirm: () => void; onClose: () => void }) {
  return (
    <Modal title="This re-run executes non-idempotent steps" onClose={onClose}>
      <p className="flex items-start gap-2">
        <AlertIcon className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
        <span>These steps are marked as unsafe to run twice. If they already took effect, running them again may do so a second time.</span>
      </p>
      <ul className="space-y-1 rounded-md bg-amber-50 px-3 py-2 text-amber-900" aria-label="Non-idempotent steps">
        {jobs.map((job) => (
          <li key={job.key}>
            <span className="font-medium">{job.name}</span>: {job.steps.join(', ')}
          </li>
        ))}
      </ul>
      <div className="flex justify-end gap-2 pt-1">
        <button type="button" className="btn-secondary" onClick={onClose}>
          Keep things as they are
        </button>
        <button type="button" className="btn-warning" onClick={onConfirm}>
          I understand: run them again
        </button>
      </div>
    </Modal>
  )
}
