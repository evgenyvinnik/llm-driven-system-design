import { memo, useState } from 'react'
import { AlertIcon, CheckIcon, CopyIcon, RefreshIcon } from '@/components/icons'
import { formatMs } from '@/lib/format'
import { Markdown } from '@/lib/markdown'
import { regenerateAnswer } from '@/services/chat-actions'
import { useGenerations } from '@/stores/generations-store'
import type { Message } from '@/types'
import { BranchNav } from './BranchNav'

interface Props {
  message: Message
  readOnly: boolean
  /** Another answer is being written in this conversation, so starting one is blocked. */
  busy: boolean
}

/**
 * An assistant message. While its generation is live, the text comes from the
 * generations store entry for THIS message's generation ID, so this component
 * re-renders on each streamed frame and nothing else in the list does. Once
 * the generation has ended, the text is the message's stored content.
 */
export const AssistantBody = memo(function AssistantBody({ message, readOnly, busy }: Props) {
  const gen = message.generation
  const live = useGenerations((s) => (gen ? s.byId[gen.id] : undefined))
  const status = live?.status ?? gen?.status ?? 'completed'
  const streaming = status === 'accepted' || status === 'running'
  const text = live && (streaming || live.text.length >= message.content.length) ? live.text : message.content
  const errorMessage = live?.errorMessage ?? gen?.errorMessage
  const truncated = live?.outputTruncated ?? gen?.outputTruncated
  const usage = live?.usage ?? gen?.usage
  const [copied, setCopied] = useState(false)

  const copy = () =>
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })

  return (
    <div className="group/msg" aria-busy={streaming}>
      {text ? (
        <Markdown text={text} />
      ) : streaming ? (
        <div className="flex gap-1 py-2" aria-label="Assistant is thinking">
          <span className="h-2 w-2 animate-pulse rounded-full bg-slate-300" />
          <span className="h-2 w-2 animate-pulse rounded-full bg-slate-300 [animation-delay:150ms]" />
          <span className="h-2 w-2 animate-pulse rounded-full bg-slate-300 [animation-delay:300ms]" />
        </div>
      ) : null}
      {streaming && text && <span className="ml-0.5 inline-block h-4 w-1.5 animate-blink bg-slate-500 align-middle" aria-hidden="true" />}

      {streaming && live?.connection === 'reconnecting' && (
        <p className="mt-2 text-xs text-amber-700">Connection dropped. Reconnecting and resuming where it left off…</p>
      )}
      {status === 'cancelled' && (
        <p className="mt-2 inline-flex items-center gap-1 text-xs text-slate-500">
          Stopped{truncated ? ' — partial answer kept' : ' before any output'}
        </p>
      )}
      {status === 'failed' && (
        <p className="mt-2 inline-flex items-center gap-1 rounded bg-red-50 px-2 py-1 text-xs text-red-700" role="note">
          <AlertIcon className="h-3.5 w-3.5" />
          {errorMessage ?? 'This answer failed'}
          {truncated ? '. The partial answer above was kept.' : '.'}
        </p>
      )}

      {!streaming && (
        <div className="mt-1 flex items-center gap-1 text-xs text-slate-400 opacity-70 transition-opacity group-hover/msg:opacity-100">
          <BranchNav message={message} disabled={readOnly} />
          <button type="button" className="btn-icon" onClick={copy} aria-label="Copy answer" title="Copy">
            {copied ? <CheckIcon className="h-3.5 w-3.5" /> : <CopyIcon className="h-3.5 w-3.5" />}
          </button>
          {!readOnly && message.parentId && (
            <button
              type="button"
              className="btn-icon"
              disabled={busy}
              onClick={() => void regenerateAnswer(message.conversationId, message.parentId!)}
              aria-label="Regenerate answer"
              title={busy ? 'Wait for the current answer to finish' : 'Regenerate (keeps this answer as another version)'}
            >
              <RefreshIcon className="h-3.5 w-3.5" />
            </button>
          )}
          {gen && (
            <span className="ml-1" title="Model · output tokens · time to first token">
              {gen.model}
              {usage?.outputTokens ? ` · ${usage.outputTokens} tok` : ''}
              {usage?.ttftMs ? ` · ${formatMs(usage.ttftMs)} TTFT` : ''}
            </span>
          )}
        </div>
      )}
    </div>
  )
})
