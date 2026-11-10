import { AlertIcon, SpinnerIcon, XIcon } from '@/components/icons'
import { formatValue } from '@/lib/display'
import type { PendingEdit } from '@/lib/settings-store'
import type { Definition } from '@/types'

interface Props {
  def: Definition
  pending: PendingEdit
  onResolve: (choice: 'mine' | 'theirs') => void
  onDismiss: () => void
}

/** The write state of one key: saving, outcome unknown, conflict (409) or rejected (422). */
export function PendingNote({ def, pending, onResolve, onDismiss }: Props) {
  if (pending.status === 'queued' || pending.status === 'saving') {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted" role="status">
        <SpinnerIcon className="h-3.5 w-3.5" /> {pending.value === null ? 'Resetting…' : 'Saving…'}
      </p>
    )
  }
  if (pending.status === 'unknown') {
    return (
      <p className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-300" role="status" data-pending="unknown">
        <SpinnerIcon className="h-3.5 w-3.5" /> Response lost. Checking the server for the outcome…
      </p>
    )
  }
  if (pending.status === 'conflict' && pending.conflict) {
    const c = pending.conflict
    return (
      <div className="w-full rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-900 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200" role="alert" data-pending="conflict">
        <p className="flex items-start gap-1.5 font-medium">
          <AlertIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Changed {c.changedBy ? `on ${c.changedBy}` : 'elsewhere'} to “{formatValue(def, c.currentValue)}” (r{c.changedAtRevision}) after this screen loaded r{c.baseRevision}.
          Nothing was saved.
        </p>
        <div className="mt-2 flex gap-2">
          <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={() => onResolve('theirs')}>
            Keep “{formatValue(def, c.currentValue)}”
          </button>
          <button type="button" className="btn-primary px-2 py-1 text-xs" onClick={() => onResolve('mine')}>
            Use mine: “{formatValue(def, pending.value)}”
          </button>
        </div>
      </div>
    )
  }
  return (
    <p className="flex items-center gap-1.5 text-xs text-red-700 dark:text-red-300" role="alert" data-pending="error">
      <AlertIcon className="h-3.5 w-3.5" />
      <span>
        {pending.error?.code ? <span className="font-mono">{pending.error.code}</span> : null} {pending.error?.message ?? 'Not saved'}
      </span>
      <button type="button" aria-label="Dismiss" className="ml-1 rounded p-0.5 hover:bg-red-100 dark:hover:bg-red-500/20" onClick={onDismiss}>
        <XIcon className="h-3 w-3" />
      </button>
    </p>
  )
}
