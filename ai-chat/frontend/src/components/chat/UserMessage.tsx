import { memo, useState } from 'react'
import { PencilIcon } from '@/components/icons'
import { editMessage } from '@/services/chat-actions'
import type { Message } from '@/types'
import { BranchNav } from './BranchNav'

interface Props {
  message: Message
  readOnly: boolean
  busy: boolean
}

/** A user message. Editing sends a new sibling message (a new branch); the original stays reachable via ‹ ›. */
export const UserMessage = memo(function UserMessage({ message, readOnly, busy }: Props) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(message.content)
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    const content = draft.trim()
    if (!content || content === message.content.trim()) {
      setEditing(false)
      return
    }
    setSaving(true)
    const result = await editMessage(message.conversationId, message, content)
    setSaving(false)
    if (result) setEditing(false)
  }

  if (editing) {
    return (
      <div className="ml-auto w-full max-w-[85%] rounded-2xl bg-slate-100 p-3">
        <label className="sr-only" htmlFor={`edit-${message.id}`}>
          Edit message
        </label>
        <textarea
          id={`edit-${message.id}`}
          className="input min-h-[80px] resize-y bg-white"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          autoFocus
          onFocus={(e) => e.currentTarget.setSelectionRange(e.currentTarget.value.length, e.currentTarget.value.length)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setEditing(false)
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void submit()
            }
          }}
        />
        <div className="mt-2 flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={() => setEditing(false)}>
            Cancel
          </button>
          <button type="button" className="btn-primary" disabled={saving || busy} onClick={() => void submit()}>
            {saving ? 'Sending…' : 'Send edit'}
          </button>
        </div>
        <p className="mt-1 text-right text-xs text-slate-500">The original message and its answers stay available as another version.</p>
      </div>
    )
  }

  return (
    <div className="group/msg flex flex-col items-end">
      <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-slate-100 px-4 py-2.5 text-[15px] leading-7 text-slate-800">
        {message.content}
      </div>
      <div className="mt-1 flex items-center gap-1 opacity-70 transition-opacity group-hover/msg:opacity-100">
        <BranchNav message={message} disabled={readOnly} />
        {!readOnly && (
          <button
            type="button"
            className="btn-icon"
            disabled={busy}
            onClick={() => {
              setDraft(message.content)
              setEditing(true)
            }}
            aria-label="Edit message"
            title={busy ? 'Wait for the current answer to finish' : 'Edit (creates a new version)'}
          >
            <PencilIcon className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  )
})
