import { useEffect, useMemo, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { ChatIcon } from '@/components/icons'
import { Composer } from '@/components/chat/Composer'
import { PendingBubble } from '@/components/chat/PendingBubble'
import { sendMessage } from '@/services/chat-actions'
import { useConversations } from '@/stores/conversations-store'

export const Route = createFileRoute('/')({ component: NewChatPage })

const STARTERS = [
  'Plan a three day trip to Kyoto with a list of steps',
  'Write a TypeScript function that groups items by key',
  'Compare renting and buying a car in a table',
  'How should a chat app render HTML from a model safely?',
]

/** New chat: the first Send creates the conversation, its first message and the generation in one request. */
function NewChatPage() {
  const navigate = useNavigate()
  const [model, setModel] = useState('sim-swift')
  const allPending = useConversations((s) => s.pending)
  const pending = useMemo(() => Object.values(allPending).filter((p) => p.conversationId === null), [allPending])

  useEffect(() => {
    useConversations.getState().setViewing(null)
  }, [])

  const send = async (content: string) => {
    const result = await sendMessage({ conversationId: null, parentMessageId: null, content, model })
    if (result) void navigate({ to: '/c/$conversationId', params: { conversationId: result.conversation.id } })
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-4">
        {pending.length === 0 ? (
          <div className="w-full max-w-2xl text-center">
            <ChatIcon className="mx-auto h-8 w-8 text-accent-600" />
            <h1 className="mt-3 text-2xl font-semibold text-slate-900">What can I help with?</h1>
            <div className="mt-6 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {STARTERS.map((s) => (
                <button
                  key={s}
                  type="button"
                  className="rounded-lg border border-slate-200 px-3 py-2 text-left text-sm text-slate-600 hover:bg-slate-50"
                  onClick={() => void send(s)}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="w-full max-w-3xl space-y-3">
            {pending.map((p) => (
              <PendingBubble key={p.key} pending={p} />
            ))}
          </div>
        )}
      </div>
      <Composer model={model} onModelChange={setModel} onSend={send} autoFocus placeholder="Ask anything" />
    </div>
  )
}
