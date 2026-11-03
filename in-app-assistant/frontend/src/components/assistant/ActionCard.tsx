import { CalendarIcon, CheckIcon, DocIcon, MailIcon, ShieldIcon, SpinnerIcon, XIcon } from '@/components/icons'
import type { PendingAction } from '@/types'

type Status = 'pending' | 'approved' | 'declined' | 'expired' | 'submitting'

const VERB: Record<string, string> = { send_draft: 'Send', create_event: 'Create & invite', insert_text: 'Apply edit', replace_text: 'Apply edit', create_draft: 'Save draft' }

function Preview({ preview }: { preview: Record<string, unknown> }) {
  const kind = preview.kind
  if (kind === 'email') {
    return (
      <div className="space-y-1 rounded-md border border-slate-200 bg-white p-2.5 text-xs">
        <div className="flex gap-1.5 text-slate-500"><MailIcon className="h-3.5 w-3.5" /> To <span className="font-medium text-slate-800">{(preview.to as string[]).join(', ')}</span></div>
        <div className="font-semibold text-slate-800">{String(preview.subject)}</div>
        <p className="line-clamp-4 whitespace-pre-line text-slate-600">{String(preview.body)}</p>
      </div>
    )
  }
  if (kind === 'event') {
    const attendees = (preview.attendees as string[]) ?? []
    return (
      <div className="space-y-1 rounded-md border border-slate-200 bg-white p-2.5 text-xs">
        <div className="flex items-center gap-1.5 font-semibold text-slate-800"><CalendarIcon className="h-3.5 w-3.5" /> {String(preview.title)}</div>
        <div className="text-slate-600">{String(preview.date)} at {String(preview.start_time)} · {String(preview.duration_minutes)} min · {String(preview.timezone)}</div>
        {attendees.length > 0 && <div className="text-slate-600">Invites {attendees.join(', ')}</div>}
      </div>
    )
  }
  return (
    <div className="space-y-1 rounded-md border border-slate-200 bg-white p-2.5 text-xs">
      <div className="flex items-center gap-1.5 font-semibold text-slate-800"><DocIcon className="h-3.5 w-3.5" /> {String(preview.title ?? 'Document')}</div>
      <p className="line-clamp-4 whitespace-pre-line text-slate-600">{String(preview.text ?? '')}</p>
      <div className="text-slate-400">{preview.mode === 'direct' ? 'Direct edit (no suggestion to review)' : 'Tracked suggestion'}</div>
    </div>
  )
}

/**
 * The confirmation card. The assistant proposed this action; nothing happens
 * until the user answers. If the conversation read content the user doesn't
 * control, the card says so, because that's when an injected instruction
 * could be behind the request.
 */
export function ActionCard({ action, status, onDecide }: { action: PendingAction; status: Status; onDecide: (approve: boolean) => void }) {
  const done = status !== 'pending' && status !== 'submitting'
  return (
    <div className={`rounded-lg border p-3 ${action.tainted ? 'border-amber-300 bg-amber-50' : 'border-accent-200 bg-accent-50/60'}`}>
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="text-[13px] font-semibold text-slate-800">{action.title}</div>
        {done && (
          <span className={`chip shrink-0 ${status === 'approved' ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-600'}`}>
            {status === 'approved' ? 'Approved' : status === 'declined' ? 'Declined' : 'Expired'}
          </span>
        )}
      </div>
      <Preview preview={action.preview} />
      <p className="mt-2 text-xs text-slate-600">{action.reason}.</p>
      {action.tainted && (
        <div className="mt-2 flex gap-1.5 rounded-md bg-amber-100 px-2 py-1.5 text-xs text-amber-900">
          <ShieldIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>The assistant read content from outside your organization in this conversation. Make sure you asked for this.</span>
        </div>
      )}
      {!done && (
        <div className="mt-3 flex gap-2">
          <button type="button" className="btn-primary" disabled={status === 'submitting'} onClick={() => onDecide(true)}>
            {status === 'submitting' ? <SpinnerIcon className="h-3.5 w-3.5" /> : <CheckIcon className="h-3.5 w-3.5" />}
            {VERB[action.tool] ?? 'Approve'}
          </button>
          <button type="button" className="btn-secondary" disabled={status === 'submitting'} onClick={() => onDecide(false)}>
            <XIcon className="h-3.5 w-3.5" /> Decline
          </button>
        </div>
      )}
    </div>
  )
}
