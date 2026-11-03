/**
 * Device sync. One stream per tab carries this user's changes from every
 * device: answers started, answers finished, renames, deletions.
 *
 * The events are hints, not the record. Pub/sub drops anything published
 * while this tab was disconnected, so every (re)connect starts with a
 * reconciliation from REST: reload the sidebar, and reattach to every
 * in-flight generation in a conversation this tab has loaded.
 */
import { api } from '@/services/api'
import { followSse } from '@/services/sse-follow'
import { useConversations } from '@/stores/conversations-store'
import { useGenerations } from '@/stores/generations-store'
import type { Conversation, GenerationResult } from '@/types'

interface DeviceEvent {
  type: string
  conversationId: string
  generationId?: string
  payload?: unknown
}

async function reconcile(): Promise<void> {
  await useConversations.getState().loadList()
  const { generations } = await api.activeGenerations()
  const threads = useConversations.getState().threads
  for (const generation of generations) {
    if (threads[generation.conversationId]) useGenerations.getState().follow(generation)
  }
}

function handle(event: DeviceEvent): void {
  const conversations = useConversations.getState()
  switch (event.type) {
    case 'generation.created': {
      const result = event.payload as GenerationResult
      conversations.applyResult(result, 'remote')
      // Stream it here too if this tab has the conversation loaded: the answer appears on both devices.
      if (conversations.threads[event.conversationId]) useGenerations.getState().follow(result.generation)
      break
    }
    case 'generation.finished': {
      // A tab that was following the stream already has the text; others fetch the final record.
      if (!useGenerations.getState().byId[event.generationId!]) {
        void api
          .getGeneration(event.generationId!)
          .then(({ generation }) => useConversations.getState().applyGeneration(generation))
          .catch(() => undefined)
      }
      break
    }
    case 'conversation.updated':
      conversations.upsertConversation(event.payload as Conversation)
      break
    case 'conversation.deleted':
      conversations.removeConversation(event.conversationId)
      break
  }
}

export function connectDeviceEvents(): () => void {
  return followSse({
    url: '/api/v1/events',
    onEvent: (type, data) => {
      if (type === 'ready') void reconcile().catch(() => undefined)
      else handle(data as DeviceEvent)
    },
  })
}
