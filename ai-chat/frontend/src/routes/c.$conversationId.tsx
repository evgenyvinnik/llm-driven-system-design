import { useEffect, useMemo, useState } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { SpinnerIcon, WifiOffIcon } from '@/components/icons'
import { Composer } from '@/components/chat/Composer'
import { MessageList } from '@/components/chat/MessageList'
import { timeAgo } from '@/lib/format'
import { sendMessage } from '@/services/chat-actions'
import { useConnectivity } from '@/stores/connectivity-store'
import { useConversations } from '@/stores/conversations-store'
import { useActiveGenerationId, useGenerations } from '@/stores/generations-store'
import { isTerminal } from '@/types'

export const Route = createFileRoute('/c/$conversationId')({ component: ConversationPage })

function ConversationPage() {
  const { conversationId } = Route.useParams()
  const thread = useConversations((s) => s.threads[conversationId])
  const conversation = useConversations((s) => s.list.find((c) => c.id === conversationId))
  const allPending = useConversations((s) => s.pending)
  const online = useConnectivity((s) => s.online)
  const activeGenerationId = useActiveGenerationId(conversationId)
  const [model, setModel] = useState<string | null>(null)

  const pending = useMemo(
    () => Object.values(allPending).filter((p) => p.conversationId === conversationId),
    [allPending, conversationId],
  )

  // Opening a conversation: show what is in memory at once, then revalidate from the server.
  useEffect(() => {
    const store = useConversations.getState()
    store.setViewing(conversationId)
    void store.loadThread(conversationId)
    setModel(null)
    return () => {
      if (useConversations.getState().viewingId === conversationId) useConversations.getState().setViewing(null)
    }
  }, [conversationId])

  // Reattach to any answer still being written in this thread (after a refresh, or from another device).
  // Following is idempotent per generation ID, so this is safe to run on every thread update.
  useEffect(() => {
    if (!thread || thread.source !== 'network') return
    for (const m of thread.messages) {
      if (m.generation && !isTerminal(m.generation.status)) useGenerations.getState().follow(m.generation)
    }
  }, [thread])

  const readOnly = !online || thread?.source === 'cache'
  const leaf = thread?.messages[thread.messages.length - 1]

  if (!thread || (thread.status === 'loading' && thread.messages.length === 0)) {
    return (
      <div className="flex flex-1 items-center justify-center text-slate-400">
        <SpinnerIcon className="h-5 w-5" />
      </div>
    )
  }

  if (thread.status === 'error' && thread.messages.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-slate-500">
        {!online && <WifiOffIcon className="h-5 w-5" />}
        <p>{thread.error}</p>
        <Link to="/" className="btn-secondary">
          Start a new chat
        </Link>
      </div>
    )
  }

  const send = (content: string) =>
    sendMessage({
      conversationId,
      parentMessageId: leaf?.id ?? null,
      content,
      model: model ?? conversation?.model,
    })

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5">
        <h1 className="truncate text-sm font-medium text-slate-800">{conversation?.title ?? 'Conversation'}</h1>
        {thread.source === 'cache' && (
          <span className="chip bg-amber-50 text-amber-800" title="Saved on this device">
            <WifiOffIcon className="h-3 w-3" /> Offline copy
            {thread.cachedAt ? ` · saved ${timeAgo(thread.cachedAt)}` : ''} · read-only
          </span>
        )}
      </header>
      <MessageList
        thread={thread}
        pending={pending}
        readOnly={readOnly}
        busy={!!activeGenerationId}
        streaming={!!activeGenerationId}
      />
      <Composer
        activeGenerationId={activeGenerationId}
        readOnlyReason={thread.source === 'cache' ? 'This is a saved offline copy. Reconnect to continue the conversation.' : undefined}
        model={model ?? conversation?.model ?? 'sim-swift'}
        onModelChange={setModel}
        onSend={send}
        autoFocus
      />
    </div>
  )
}
