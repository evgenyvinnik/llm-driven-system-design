import { SeverityChip } from '@/components/shared/Chips'
import { ReasonDialog, type ReasonValue } from '@/components/shared/ReasonDialog'
import type { Violation } from '@/types'

export interface PendingEdit {
  title: string
  apply: (v: ReasonValue, overrideSoft: boolean) => Promise<void>
}

/** Asks why, then shows what the validator said. Operating rules can be overridden; safety and physical ones can't. */
export function EditDialog({ edit, violations, overridable, busy, onCancel, onConfirm }: { edit: PendingEdit; violations: Violation[] | null; overridable: boolean; busy: boolean; onCancel: () => void; onConfirm: (v: ReasonValue, overrideSoft: boolean) => void }) {
  const refused = violations !== null && !overridable
  return (
    <ReasonDialog title={edit.title} confirmLabel={overridable ? 'Override and record' : 'Apply'} busy={busy || refused} onCancel={onCancel} onConfirm={(v) => onConfirm(v, overridable)}>
      {violations && violations.length > 0 && (
        <div className="space-y-1 rounded-md border border-rose-300 bg-rose-100 p-2 text-sm text-rose-900" role="alert" data-testid="edit-violations">
          <p className="font-semibold">{overridable ? 'This breaks an operating rule. You can override it, and it will be recorded.' : 'This edit was refused. It breaks a rule that nobody can override.'}</p>
          {violations.slice(0, 6).map((x, i) => (
            <div key={i} className="flex items-start gap-1.5">
              <SeverityChip severity={x.severity} /> <span>{x.message}</span>
            </div>
          ))}
        </div>
      )}
    </ReasonDialog>
  )
}
