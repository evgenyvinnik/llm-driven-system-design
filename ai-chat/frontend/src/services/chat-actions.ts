/**
 * User actions that ask the model for an answer, and their retry rules.
 *
 * Each action mints one idempotency key when the user clicks. While the
 * outcome is unknown (the request failed to connect, or the connection
 * dropped before a response) every retry reuses that key, so the server
 * returns the generation it may already have created instead of asking the
 * model again. Once the server has answered with a definitive rejection
 * (409, 422, 429), nothing was created, and the next attempt is a new request
 * with a new key. "Regenerate" is never a retry: it always gets a new key,
 * because the user is asking for a different answer.
 */
import { api, ApiError, isNetworkError } from '@/services/api'
import { useConversations, type PendingSend } from '@/stores/conversations-store'
import { useGenerations } from '@/stores/generations-store'
import { useUi } from '@/stores/ui-store'
import type { GenerationResult } from '@/types'

const newKey = () => crypto.randomUUID()
const RETRY_DELAYS_MS = [500, 1500, 4000]
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Retries only while the outcome is unknown; the key passed in stays the same across attempts. */
async function withUnknownOutcomeRetries<T>(attempt: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await attempt()
    } catch (err) {
      if (!isNetworkError(err) || i >= RETRY_DELAYS_MS.length) throw err
      await sleep(RETRY_DELAYS_MS[i])
    }
  }
}

function accepted(result: GenerationResult): GenerationResult {
  useConversations.getState().applyResult(result, 'local')
  useGenerations.getState().follow(result.generation)
  return result
}

/** The answer already being written here (perhaps from another device): attach to it rather than fail silently. */
async function attachToInFlight(err: unknown): Promise<void> {
  const generationId = ((err as ApiError).details as { generationId?: string } | undefined)?.generationId
  if (!generationId) return
  const { generation } = await api.getGeneration(generationId)
  await useConversations.getState().loadThread(generation.conversationId)
  useGenerations.getState().follow(generation)
}

async function runPending(pending: PendingSend): Promise<GenerationResult | null> {
  const store = useConversations.getState()
  store.putPending({ ...pending, status: 'sending', error: undefined })
  try {
    const result = await withUnknownOutcomeRetries(() =>
      pending.conversationId
        ? api.sendMessage(
            pending.conversationId,
            { content: pending.content, parentMessageId: pending.parentMessageId, model: pending.model },
            pending.key,
          )
        : api.createConversation({ content: pending.content, model: pending.model }, pending.key),
    )
    useConversations.getState().removePending(pending.key)
    return accepted(result)
  } catch (err) {
    const unknown = isNetworkError(err)
    let message = unknown ? 'Not sent: the connection dropped. Retrying is safe.' : (err as Error).message
    if (err instanceof ApiError && err.code === 'GENERATION_IN_PROGRESS') {
      message = 'An answer is already being written in this chat (perhaps on another device). Wait for it, then retry.'
      void attachToInFlight(err).catch(() => undefined)
    }
    useConversations.getState().putPending({ ...pending, status: 'failed', error: message, reuseKey: unknown })
    return null
  }
}

export function sendMessage(input: {
  conversationId: string | null
  parentMessageId: string | null
  content: string
  model?: string
}): Promise<GenerationResult | null> {
  return runPending({ key: newKey(), ...input, status: 'sending', reuseKey: true })
}

/** Retry a failed send: same key if the first attempt's outcome is unknown, a new one if it was rejected. */
export function retryPending(key: string): Promise<GenerationResult | null> {
  const pending = useConversations.getState().pending[key]
  if (!pending) return Promise.resolve(null)
  if (pending.reuseKey) return runPending(pending)
  useConversations.getState().removePending(key)
  // A rejected send created nothing: re-target the current leaf with a fresh key.
  const thread = pending.conversationId ? useConversations.getState().threads[pending.conversationId] : undefined
  const leaf = thread?.messages[thread.messages.length - 1]
  return sendMessage({ ...pending, parentMessageId: leaf?.id ?? pending.parentMessageId })
}

export function discardPending(key: string): void {
  useConversations.getState().removePending(key)
}

async function report<T>(action: () => Promise<T>): Promise<T | null> {
  try {
    return await action()
  } catch (err) {
    if (err instanceof ApiError && err.code === 'GENERATION_IN_PROGRESS') {
      useUi.getState().toast({ message: 'An answer is already being written in this chat.', tone: 'info' })
      void attachToInFlight(err).catch(() => undefined)
    } else {
      useUi.getState().toast({ message: (err as Error).message, tone: 'error' })
    }
    return null
  }
}

/** Edit = a new user message beside the old one (same parent), answered on a new branch. */
export function editMessage(conversationId: string, original: { id: string; parentId: string | null }, content: string) {
  const key = newKey()
  return report(async () =>
    accepted(
      await withUnknownOutcomeRetries(() =>
        api.sendMessage(conversationId, { content, parentMessageId: original.parentId, editOfMessageId: original.id }, key),
      ),
    ),
  )
}

/** Regenerate = a new generation (and assistant sibling) for the same user message. Always a new key. */
export function regenerateAnswer(conversationId: string, userMessageId: string, model?: string) {
  const key = newKey()
  return report(async () =>
    accepted(await withUnknownOutcomeRetries(() => api.regenerate(conversationId, userMessageId, key, model))),
  )
}

/** Stop cancels the backend work (the executor aborts the model request); the partial answer is kept. */
export function stopGeneration(generationId: string) {
  return report(() => useGenerations.getState().cancel(generationId))
}
