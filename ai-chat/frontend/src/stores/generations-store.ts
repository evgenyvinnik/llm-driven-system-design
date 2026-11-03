/**
 * Live generation state for the whole app, keyed by generation ID.
 *
 * This is the store the A → B switch depends on. Each stream writes only to
 * its own generation's entry, and each assistant message subscribes only to
 * the entry for its own generation ID. So:
 *   - switching from conversation A to B mid-answer does not cancel A: the
 *     stream lives here, outside any component, and keeps writing to A's entry;
 *   - A's tokens can never appear in B: nothing in B reads A's entry, and no
 *     code anywhere appends to "the current conversation";
 *   - when A's answer ends, its final text is written into A's thread in the
 *     conversations store (and the offline cache) wherever the user is, with
 *     a toast if they are elsewhere and a screen-reader announcement if not.
 *
 * Deltas are batched per animation frame (FrameBatcher), and an entry's
 * status only moves forward, so a stale REST copy (e.g. the Stop request's
 * reply arriving after the stream's end) can never move it backwards.
 */
import { create } from 'zustand'
import { FrameBatcher } from '@/lib/frame-batcher'
import { api } from '@/services/api'
import { followSse, type ConnectionState } from '@/services/sse-follow'
import { useConversations } from '@/stores/conversations-store'
import { useUi } from '@/stores/ui-store'
import { isTerminal, type EndEvent, type Generation, type GenerationStatus, type GenerationUsage } from '@/types'

export interface LiveGeneration {
  id: string
  conversationId: string
  userMessageId: string
  assistantMessageId: string
  status: GenerationStatus
  text: string
  /** The last stream entry applied; a reconnect resumes after it. */
  lastEventId: string | null
  connection: ConnectionState
  outputTruncated: boolean
  finishReason: string | null
  errorCode: string | null
  errorMessage: string | null
  usage: GenerationUsage | null
  cancelRequested: boolean
  streamError?: string
}

interface GenerationsState {
  byId: Record<string, LiveGeneration>
  follow: (generation: Generation) => void
  cancel: (id: string) => Promise<void>
  stopFollowing: (id: string) => void
  reset: () => void
}

const closers = new Map<string, () => void>()

/** Lifecycle order. An entry only moves forward, so a lower-ranked copy is always stale. */
const STAGE: Record<GenerationStatus, number> = { accepted: 0, running: 1, completed: 2, cancelled: 2, failed: 2 }

const fromGeneration = (g: Generation, connection: ConnectionState): LiveGeneration => ({
  id: g.id,
  conversationId: g.conversationId,
  userMessageId: g.userMessageId,
  assistantMessageId: g.assistantMessageId,
  status: g.status,
  text: g.output,
  lastEventId: g.checkpointEventId,
  connection,
  outputTruncated: g.outputTruncated,
  finishReason: g.finishReason,
  errorCode: g.errorCode,
  errorMessage: g.errorMessage,
  usage: g.usage,
  cancelRequested: g.cancelRequested,
})

export const useGenerations = create<GenerationsState>((set, get) => {
  const patch = (id: string, fields: Partial<LiveGeneration>) => {
    const current = get().byId[id]
    if (!current) return
    set({ byId: { ...get().byId, [id]: { ...current, ...fields } } })
  }

  // One commit per frame for every streaming generation together.
  const batcher = new FrameBatcher<{ text: string; eventId: string | undefined }>((batch) => {
    const byId = { ...get().byId }
    for (const [id, deltas] of batch) {
      const current = byId[id]
      if (!current) continue
      byId[id] = {
        ...current,
        text: current.text + deltas.map((d) => d.text).join(''),
        lastEventId: deltas[deltas.length - 1].eventId ?? current.lastEventId,
      }
    }
    set({ byId })
  })

  const finished = (id: string) => {
    const entry = get().byId[id]
    if (!entry) return
    const conversations = useConversations.getState()
    // Optimistically write what we streamed; then replace it with the server's record.
    const thread = conversations.threads[entry.conversationId]
    const message = thread?.messages.find((m) => m.id === entry.assistantMessageId)
    if (message?.generation) {
      conversations.applyGeneration({
        ...message.generation,
        status: entry.status,
        output: entry.text,
        outputTruncated: entry.outputTruncated,
        finishReason: entry.finishReason,
        errorCode: entry.errorCode,
        errorMessage: entry.errorMessage,
        usage: entry.usage ?? message.generation.usage,
      })
    }
    void api
      .getGeneration(id)
      .then(({ generation }) => useConversations.getState().applyGeneration(generation))
      .catch(() => undefined)

    const viewing = useConversations.getState().viewingId === entry.conversationId
    const verb = entry.status === 'completed' ? 'complete' : entry.status === 'cancelled' ? 'stopped' : 'failed'
    if (viewing) {
      useUi.getState().announce(`Response ${verb}.`)
    } else {
      const title = useConversations.getState().list.find((c) => c.id === entry.conversationId)?.title ?? 'a conversation'
      useUi.getState().toast({
        message: `Answer ${verb === 'complete' ? 'finished' : verb} in “${title}”`,
        tone: entry.status === 'failed' ? 'error' : entry.status === 'completed' ? 'success' : 'info',
        conversationId: entry.conversationId,
      })
    }
  }

  return {
    byId: {},

    follow: (generation) => {
      const existing = get().byId[generation.id]
      if (existing && (closers.has(generation.id) || STAGE[existing.status] > STAGE[generation.status])) return
      if (isTerminal(generation.status)) {
        set({ byId: { ...get().byId, [generation.id]: fromGeneration(generation, 'closed') } })
        return
      }
      // Seed from the PostgreSQL checkpoint and resume the stream right after it,
      // instead of replaying every token from the start.
      set({ byId: { ...get().byId, [generation.id]: fromGeneration(generation, 'connecting') } })
      const id = generation.id
      if (useConversations.getState().viewingId === generation.conversationId) {
        useUi.getState().announce('Assistant is responding.')
      }
      const close = followSse({
        url: `/api/v1/generations/${id}/events`,
        lastEventId: generation.checkpointEventId,
        isFinal: (type) => type === 'end' || type === 'snapshot',
        onConnection: (connection) => patch(id, { connection }),
        onFatal: (status) => {
          closers.delete(id)
          patch(id, { streamError: status === 401 ? 'Signed out' : 'Not available', connection: 'closed' })
        },
        onEvent: (type, data, eventId) => {
          const current = get().byId[id]
          if (!current) return
          if (type === 'delta') {
            batcher.push(id, { text: (data as { text: string }).text, eventId })
          } else if (type === 'status') {
            const d = data as { status: GenerationStatus }
            if (STAGE[d.status] > STAGE[current.status]) patch(id, { status: d.status })
          } else if (type === 'end') {
            batcher.flush() // no delta may be left behind the end
            const d = data as EndEvent
            patch(id, {
              status: d.status,
              outputTruncated: d.outputTruncated,
              finishReason: d.finishReason,
              errorCode: d.errorCode,
              errorMessage: d.errorMessage,
              usage: d.usage,
              lastEventId: eventId ?? current.lastEventId,
            })
            closers.delete(id)
            finished(id)
          } else if (type === 'snapshot') {
            // The live stream expired: PostgreSQL's final record replaces whatever we had.
            batcher.drop(id)
            closers.delete(id)
            set({ byId: { ...get().byId, [id]: fromGeneration(data as Generation, 'closed') } })
            finished(id)
          }
        },
      })
      closers.set(id, close)
    },

    cancel: async (id) => {
      patch(id, { cancelRequested: true })
      const { generation } = await api.cancelGeneration(id)
      // The reply may say "running" after the stream already delivered "cancelled": never go backwards.
      const current = get().byId[id]
      if (current && STAGE[generation.status] > STAGE[current.status] && !closers.has(id)) {
        set({ byId: { ...get().byId, [id]: fromGeneration(generation, 'closed') } })
        finished(id)
      }
    },

    stopFollowing: (id) => {
      closers.get(id)?.()
      closers.delete(id)
      batcher.drop(id)
    },

    reset: () => {
      for (const id of [...closers.keys()]) get().stopFollowing(id)
      set({ byId: {} })
    },
  }
})

/**
 * The ID of the in-flight generation for a conversation, if any (the server allows at most one).
 * Selects a string, not the entry, so callers don't re-render on every streamed frame.
 */
export function useActiveGenerationId(conversationId: string | null): string | undefined {
  return useGenerations((s) =>
    conversationId
      ? Object.values(s.byId).find((g) => g.conversationId === conversationId && !isTerminal(g.status))?.id
      : undefined,
  )
}
