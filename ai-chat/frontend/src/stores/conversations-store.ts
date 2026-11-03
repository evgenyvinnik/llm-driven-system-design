/**
 * Server state for the sidebar and for every conversation thread the client
 * has loaded, keyed by conversation ID.
 *
 * Threads are kept after the user navigates away, which is what lets an
 * answer that finishes in conversation A land in A's history while the user
 * is reading B: the generations store writes the final text into A's thread
 * here, and into the offline cache, whatever is on screen.
 *
 * A thread holds the visible path (root → current leaf), oldest first, of
 * which only the newest pages may be loaded. Live tokens are NOT stored here;
 * they live in the generations store keyed by generation ID.
 */
import { create } from 'zustand'
import { api, isNetworkError } from '@/services/api'
import * as cache from '@/services/offline-cache'
import { useConnectivity } from '@/stores/connectivity-store'
import type { Conversation, ConversationView, Generation, GenerationResult, Message } from '@/types'

export interface Thread {
  conversationId: string
  messages: Message[]
  hasMoreBefore: boolean
  status: 'loading' | 'ready' | 'error'
  /** 'cache' means this is the read-only offline copy. */
  source: 'network' | 'cache'
  cachedAt?: number
  loadingOlder: boolean
  error?: string
}

/** A Send that has not been acknowledged yet, keyed by its idempotency key. */
export interface PendingSend {
  key: string
  conversationId: string | null
  parentMessageId: string | null
  content: string
  model?: string
  status: 'sending' | 'failed'
  error?: string
  /** True while the outcome is unknown (network error): a retry must reuse the key. */
  reuseKey: boolean
}

interface ConversationsState {
  list: Conversation[]
  listStatus: 'idle' | 'loading' | 'ready' | 'error'
  listSource: 'network' | 'cache'
  nextCursor: string | null
  threads: Record<string, Thread>
  pending: Record<string, PendingSend>
  unread: Record<string, boolean>
  viewingId: string | null

  setViewing: (id: string | null) => void
  loadList: () => Promise<void>
  loadMoreList: () => Promise<void>
  loadThread: (id: string) => Promise<void>
  loadOlder: (id: string) => Promise<void>
  setThread: (view: ConversationView, source?: 'network' | 'cache') => void
  switchBranch: (id: string, messageId: string) => Promise<void>
  applyResult: (result: GenerationResult, origin: 'local' | 'remote') => void
  applyGeneration: (generation: Generation) => void
  upsertConversation: (conversation: Conversation) => void
  removeConversation: (id: string) => void
  putPending: (pending: PendingSend) => void
  removePending: (key: string) => void
  reset: () => void
}

const byRecency = (a: Conversation, b: Conversation) =>
  b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id)

export const useConversations = create<ConversationsState>((set, get) => {
  const patchThread = (id: string, fields: Partial<Thread>) => {
    const current = get().threads[id]
    if (!current) return
    set({ threads: { ...get().threads, [id]: { ...current, ...fields } } })
  }

  const persist = (id: string) => {
    const thread = get().threads[id]
    const conversation = get().list.find((c) => c.id === id)
    if (thread && conversation && thread.source === 'network') {
      void cache.saveThread(conversation, thread.messages, thread.hasMoreBefore)
    }
  }

  const loadThreadFromCache = async (id: string) => {
    const cached = await cache.loadThread(id)
    if (!cached) {
      patchThread(id, { status: 'error', error: 'This conversation is not available offline' })
      return
    }
    get().upsertConversation(cached.conversation)
    set({
      threads: {
        ...get().threads,
        [id]: {
          conversationId: id,
          messages: cached.messages,
          hasMoreBefore: cached.hasMoreBefore,
          status: 'ready',
          source: 'cache',
          cachedAt: cached.cachedAt,
          loadingOlder: false,
        },
      },
    })
  }

  return {
    list: [],
    listStatus: 'idle',
    listSource: 'network',
    nextCursor: null,
    threads: {},
    pending: {},
    unread: {},
    viewingId: null,

    setViewing: (id) => {
      const unread = { ...get().unread }
      if (id) delete unread[id]
      set({ viewingId: id, unread })
    },

    loadList: async () => {
      if (get().listStatus === 'idle') set({ listStatus: 'loading' })
      try {
        const { conversations, nextCursor } = await api.listConversations()
        // Keep conversations created locally since the request started.
        const fresh = new Set(conversations.map((c) => c.id))
        const extra = get().list.filter((c) => !fresh.has(c.id) && get().threads[c.id]?.source === 'network')
        set({ list: [...conversations, ...extra].sort(byRecency), nextCursor, listStatus: 'ready', listSource: 'network' })
        void cache.saveConversationList(get().list)
      } catch (err) {
        if (!isNetworkError(err)) {
          set({ listStatus: 'error' })
          return
        }
        const cached = await cache.loadConversationList()
        set({ list: cached ?? [], listStatus: 'ready', listSource: 'cache', nextCursor: null })
      }
    },

    loadMoreList: async () => {
      const cursor = get().nextCursor
      if (!cursor) return
      const { conversations, nextCursor } = await api.listConversations(cursor)
      const known = new Set(get().list.map((c) => c.id))
      set({ list: [...get().list, ...conversations.filter((c) => !known.has(c.id))], nextCursor })
    },

    loadThread: async (id) => {
      const existing = get().threads[id]
      if (!existing) {
        set({
          threads: {
            ...get().threads,
            [id]: { conversationId: id, messages: [], hasMoreBefore: false, status: 'loading', source: 'network', loadingOlder: false },
          },
        })
      }
      if (!useConnectivity.getState().online) {
        if (!existing || existing.status !== 'ready') await loadThreadFromCache(id)
        return
      }
      try {
        get().setThread(await api.getConversation(id))
      } catch (err) {
        if (isNetworkError(err)) {
          if (!existing || existing.status !== 'ready') await loadThreadFromCache(id)
          return
        }
        patchThread(id, {
          status: 'error',
          error: (err as { status?: number }).status === 404 ? 'Conversation not found' : 'Could not load this conversation',
        })
      }
    },

    loadOlder: async (id) => {
      const thread = get().threads[id]
      if (!thread || !thread.hasMoreBefore || thread.loadingOlder || thread.source === 'cache') return
      const oldest = thread.messages[0]
      if (!oldest) return
      patchThread(id, { loadingOlder: true })
      try {
        const page = await api.olderMessages(id, oldest.id)
        const current = get().threads[id]
        // The thread may have switched branch while this was loading; only prepend onto the same path.
        if (!current || current.messages[0]?.id !== oldest.id) return
        patchThread(id, { messages: [...page.messages, ...current.messages], hasMoreBefore: page.hasMoreBefore })
      } finally {
        patchThread(id, { loadingOlder: false })
      }
    },

    setThread: (view, source = 'network') => {
      const id = view.conversation.id
      get().upsertConversation(view.conversation)
      set({
        threads: {
          ...get().threads,
          [id]: {
            conversationId: id,
            messages: view.messages,
            hasMoreBefore: view.hasMoreBefore,
            status: 'ready',
            source,
            loadingOlder: false,
          },
        },
      })
      persist(id)
    },

    switchBranch: async (id, messageId) => {
      get().setThread(await api.switchBranch(id, messageId))
    },

    applyResult: (result, origin) => {
      const { conversation, userMessage, assistantMessage, generation } = result
      get().upsertConversation(conversation)
      const thread = get().threads[conversation.id]
      if (!thread) {
        if (origin === 'local') {
          // A brand-new conversation created from this device.
          set({
            threads: {
              ...get().threads,
              [conversation.id]: {
                conversationId: conversation.id,
                messages: [userMessage, assistantMessage],
                hasMoreBefore: false,
                status: 'ready',
                source: 'network',
                loadingOlder: false,
              },
            },
          })
        }
        return
      }
      if (thread.messages.some((m) => m.id === assistantMessage.id)) return // echo of our own request

      const added = generation.kind === 'regenerate' ? [assistantMessage] : [userMessage, assistantMessage]
      const anchor = added[0].parentId
      const leaf = thread.messages[thread.messages.length - 1]
      const anchorIndex = anchor === null ? -1 : thread.messages.findIndex((m) => m.id === anchor)
      const continuesView = anchor === null ? thread.messages.length === 0 : leaf?.id === anchor

      if (origin === 'local' || continuesView) {
        // Show the new branch: the path up to the anchor, then the new messages.
        if (anchor !== null && anchorIndex === -1) {
          // The anchor is in a page not loaded yet: start from the new messages and page back to it.
          patchThread(conversation.id, { messages: added, hasMoreBefore: true })
          return
        }
        patchThread(conversation.id, { messages: [...thread.messages.slice(0, anchorIndex + 1), ...added] })
        return
      }
      // Another device branched somewhere else in this conversation: keep the user's view,
      // just let the affected message show one more sibling ("‹ 1/2 ›").
      const first = added[0]
      patchThread(conversation.id, {
        messages: thread.messages.map((m) =>
          m.parentId === first.parentId && m.role === first.role && !m.siblingIds.includes(first.id)
            ? { ...m, siblingIds: [...m.siblingIds, first.id] }
            : m,
        ),
      })
    },

    applyGeneration: (generation) => {
      const id = generation.conversationId
      const thread = get().threads[id]
      if (thread) {
        patchThread(id, {
          messages: thread.messages.map((m) =>
            m.id === generation.assistantMessageId ? { ...m, content: generation.output, generation } : m,
          ),
        })
      }
      const conversation = get().list.find((c) => c.id === id)
      if (conversation && conversation.activeGenerationId === generation.id && generation.status !== 'running') {
        get().upsertConversation({
          ...conversation,
          activeGenerationId: null,
          updatedAt: generation.finishedAt ?? conversation.updatedAt,
        })
      }
      if (get().viewingId !== id && generation.status === 'completed') {
        set({ unread: { ...get().unread, [id]: true } })
      }
      persist(id)
    },

    upsertConversation: (conversation) => {
      const others = get().list.filter((c) => c.id !== conversation.id)
      set({ list: [conversation, ...others].sort(byRecency) })
    },

    removeConversation: (id) => {
      const threads = { ...get().threads }
      // Deleted on another device while open here: say so instead of leaving a dead thread on screen.
      if (get().viewingId === id) {
        threads[id] = {
          conversationId: id,
          messages: [],
          hasMoreBefore: false,
          status: 'error',
          source: 'network',
          loadingOlder: false,
          error: 'This conversation was deleted',
        }
      } else {
        delete threads[id]
      }
      set({ list: get().list.filter((c) => c.id !== id), threads })
      void cache.removeThread(id)
    },

    putPending: (pending) => set({ pending: { ...get().pending, [pending.key]: pending } }),
    removePending: (key) => {
      const pending = { ...get().pending }
      delete pending[key]
      set({ pending })
    },

    reset: () =>
      set({
        list: [],
        listStatus: 'idle',
        listSource: 'network',
        nextCursor: null,
        threads: {},
        pending: {},
        unread: {},
        viewingId: null,
      }),
  }
})
