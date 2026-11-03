import { useState } from 'react'
import { ChevronLeftIcon, ChevronRightIcon } from '@/components/icons'
import { useConversations } from '@/stores/conversations-store'
import { useUi } from '@/stores/ui-store'
import type { Message } from '@/types'

/**
 * "‹ 2/3 ›" for a message with siblings: other versions of a user message
 * (edits) or other answers to the same question (regenerations). Choosing a
 * sibling asks the server for the latest state of that branch and makes it
 * the conversation's current leaf, so other devices and a reload see it too.
 */
export function BranchNav({ message, disabled }: { message: Message; disabled: boolean }) {
  const [switching, setSwitching] = useState(false)
  const total = message.siblingIds.length
  if (total < 2) return null
  const index = Math.max(0, message.siblingIds.indexOf(message.id))
  const go = async (siblingId: string | undefined) => {
    if (!siblingId) return
    setSwitching(true)
    try {
      await useConversations.getState().switchBranch(message.conversationId, siblingId)
    } catch (err) {
      useUi.getState().toast({ message: (err as Error).message, tone: 'error' })
    } finally {
      setSwitching(false)
    }
  }
  const noun = message.role === 'user' ? 'version' : 'answer'
  return (
    <span className="inline-flex items-center text-xs text-slate-500" role="group" aria-label={`${noun} ${index + 1} of ${total}`}>
      <button
        type="button"
        className="btn-icon !h-6 !w-6"
        disabled={disabled || switching || index === 0}
        onClick={() => void go(message.siblingIds[index - 1])}
        aria-label={`Previous ${noun}`}
      >
        <ChevronLeftIcon className="h-3.5 w-3.5" />
      </button>
      <span className="tabular-nums" aria-hidden="true">
        {index + 1}/{total}
      </span>
      <button
        type="button"
        className="btn-icon !h-6 !w-6"
        disabled={disabled || switching || index === total - 1}
        onClick={() => void go(message.siblingIds[index + 1])}
        aria-label={`Next ${noun}`}
      >
        <ChevronRightIcon className="h-3.5 w-3.5" />
      </button>
    </span>
  )
}
