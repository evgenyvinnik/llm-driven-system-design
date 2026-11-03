import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowDownIcon, SpinnerIcon } from '@/components/icons'
import type { PendingSend, Thread } from '@/stores/conversations-store'
import { useConversations } from '@/stores/conversations-store'
import type { Message } from '@/types'
import { AssistantBody } from './AssistantBody'
import { PendingBubble } from './PendingBubble'
import { UserMessage } from './UserMessage'

type Item =
  | { kind: 'loader'; id: string }
  | { kind: 'message'; id: string; message: Message }
  | { kind: 'pending'; id: string; pending: PendingSend }

interface Props {
  thread: Thread
  pending: PendingSend[]
  readOnly: boolean
  busy: boolean
  streaming: boolean
}

const BOTTOM_SLACK_PX = 80
const LOAD_OLDER_PX = 400

/**
 * The conversation, virtualized: only the messages near the viewport are in
 * the DOM, so a 5,000-message thread scrolls like a 50-message one.
 *
 * Scrolling rules:
 *   - follow the stream only while the user is at the bottom. Scrolling up
 *     to re-read something stops the auto-scroll, and a "Jump to latest"
 *     button appears instead of yanking them back on every frame;
 *   - sending a message always returns to the bottom;
 *   - loading older messages (near the top) keeps what the user is looking
 *     at in place, by shifting scrollTop by the height that was added above.
 */
export function MessageList({ thread, pending, readOnly, busy, streaming }: Props) {
  const parentRef = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)
  const [showJump, setShowJump] = useState(false)

  const items: Item[] = useMemo(
    () => [
      ...(thread.hasMoreBefore ? [{ kind: 'loader' as const, id: 'loader' }] : []),
      ...thread.messages.map((m) => ({ kind: 'message' as const, id: m.id, message: m })),
      ...pending.map((p) => ({ kind: 'pending' as const, id: p.key, pending: p })),
    ],
    [thread.hasMoreBefore, thread.messages, pending],
  )

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (i) => (items[i]?.kind === 'message' && items[i].message.role === 'assistant' ? 320 : 96),
    overscan: 6,
    getItemKey: (i) => items[i]?.id ?? i,
  })
  const totalSize = virtualizer.getTotalSize()

  // A new conversation opens at the bottom.
  useLayoutEffect(() => {
    atBottom.current = true
    setShowJump(false)
  }, [thread.conversationId])

  // Sending a message returns to the bottom, wherever the user had scrolled.
  const last = items[items.length - 1]
  useEffect(() => {
    if (last?.kind === 'pending') atBottom.current = true
  }, [last?.id, last?.kind])

  // Older messages were prepended: keep the same content under the user's eyes.
  const firstMessageId = thread.messages[0]?.id
  const anchor = useRef<{ firstId: string | undefined; height: number }>({ firstId: undefined, height: 0 })
  useLayoutEffect(() => {
    const el = parentRef.current
    if (!el) return
    const prev = anchor.current
    const prepended =
      prev.firstId !== undefined && prev.firstId !== firstMessageId && thread.messages.some((m) => m.id === prev.firstId)
    if (prepended && !atBottom.current) el.scrollTop += el.scrollHeight - prev.height
    anchor.current = { firstId: firstMessageId, height: el.scrollHeight }
  })

  // Follow the stream while (and only while) the user is at the bottom.
  useLayoutEffect(() => {
    const el = parentRef.current
    if (el && atBottom.current) el.scrollTop = el.scrollHeight
  }, [totalSize, items.length])

  const onScroll = () => {
    const el = parentRef.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    atBottom.current = distance < BOTTOM_SLACK_PX
    setShowJump(!atBottom.current)
    if (el.scrollTop < LOAD_OLDER_PX && thread.hasMoreBefore && !thread.loadingOlder) {
      void useConversations.getState().loadOlder(thread.conversationId)
    }
  }

  const jump = () => {
    const el = parentRef.current
    if (!el) return
    atBottom.current = true
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }

  const setSize = thread.hasMoreBefore ? -1 : thread.messages.length

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={parentRef} onScroll={onScroll} className="h-full overflow-y-auto" data-testid="message-scroller">
        <div
          role="feed"
          aria-busy={thread.loadingOlder || streaming}
          aria-label="Conversation"
          style={{ height: totalSize, position: 'relative', width: '100%' }}
        >
          {virtualizer.getVirtualItems().map((row) => {
            const item = items[row.index]
            if (!item) return null
            return (
              <div
                key={row.key}
                data-index={row.index}
                ref={virtualizer.measureElement}
                style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${row.start}px)` }}
              >
                <div className="mx-auto max-w-3xl px-4 py-3">
                  {item.kind === 'loader' && (
                    <div className="flex justify-center py-2 text-xs text-slate-400">
                      {thread.loadingOlder ? (
                        <span className="inline-flex items-center gap-1.5">
                          <SpinnerIcon className="h-3 w-3" /> Loading earlier messages…
                        </span>
                      ) : readOnly ? (
                        'Earlier messages are not saved offline'
                      ) : (
                        'Scroll up for earlier messages'
                      )}
                    </div>
                  )}
                  {item.kind === 'pending' && <PendingBubble pending={item.pending} />}
                  {item.kind === 'message' && (
                    <article
                      aria-label={item.message.role === 'user' ? 'You said' : 'Assistant said'}
                      aria-posinset={thread.hasMoreBefore ? undefined : row.index + 1}
                      aria-setsize={setSize}
                      data-message-id={item.message.id}
                      data-role={item.message.role}
                    >
                      {item.message.role === 'user' ? (
                        <UserMessage message={item.message} readOnly={readOnly} busy={busy} />
                      ) : (
                        <AssistantBody message={item.message} readOnly={readOnly} busy={busy} />
                      )}
                    </article>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>
      {showJump && (
        <button
          type="button"
          onClick={jump}
          className="absolute bottom-3 left-1/2 inline-flex -translate-x-1/2 items-center gap-1 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs text-slate-700 shadow-md hover:bg-slate-50"
        >
          <ArrowDownIcon className="h-3.5 w-3.5" />
          {streaming ? 'New output below' : 'Jump to latest'}
        </button>
      )}
    </div>
  )
}
