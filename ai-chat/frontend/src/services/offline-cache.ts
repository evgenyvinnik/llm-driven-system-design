/**
 * Recent conversations cached in IndexedDB, readable when the server is not.
 *
 * One database per user (`ai-chat-<userId>`), deleted on sign-out, so a
 * shared computer never shows one person's chats to the next. Only the
 * sidebar list and the newest page of each recently opened thread are kept,
 * capped at MAX_THREADS conversations (least recently cached evicted first).
 * The cache is a read-only copy: nothing is ever sent from it.
 *
 * Every call swallows errors. Private browsing, a full disk or a blocked
 * database must degrade to "no offline copy", never break the app.
 */
import { openDB, type IDBPDatabase } from 'idb'
import type { Conversation, Message, User } from '@/types'

const MAX_THREADS = 20
const MAX_MESSAGES_PER_THREAD = 60
const LAST_USER_KEY = 'ai-chat:last-user'

export interface CachedThread {
  conversation: Conversation
  messages: Message[]
  hasMoreBefore: boolean
  cachedAt: number
}

let db: Promise<IDBPDatabase> | null = null
let dbUser: string | null = null

function open(userId: string): Promise<IDBPDatabase> {
  if (!db || dbUser !== userId) {
    dbUser = userId
    db = openDB(`ai-chat-${userId}`, 1, {
      upgrade(database) {
        database.createObjectStore('meta')
        const threads = database.createObjectStore('threads', { keyPath: 'conversation.id' })
        threads.createIndex('cachedAt', 'cachedAt')
      },
    })
  }
  return db
}

let activeUser: string | null = null

export function setCacheUser(user: User | null): void {
  activeUser = user?.id ?? null
  try {
    // Only what is needed to reopen the cache offline; never anything secret.
    if (user) localStorage.setItem(LAST_USER_KEY, JSON.stringify(user))
  } catch {
    /* storage unavailable */
  }
}

export function lastCachedUser(): User | null {
  try {
    const raw = localStorage.getItem(LAST_USER_KEY)
    return raw ? (JSON.parse(raw) as User) : null
  } catch {
    return null
  }
}

export async function saveConversationList(list: Conversation[]): Promise<void> {
  if (!activeUser) return
  try {
    await (await open(activeUser)).put('meta', list.slice(0, 100), 'conversations')
  } catch {
    /* no offline copy */
  }
}

export async function loadConversationList(): Promise<Conversation[] | null> {
  if (!activeUser) return null
  try {
    return ((await (await open(activeUser)).get('meta', 'conversations')) as Conversation[] | undefined) ?? null
  } catch {
    return null
  }
}

export async function saveThread(conversation: Conversation, messages: Message[], hasMoreBefore: boolean): Promise<void> {
  if (!activeUser || messages.length === 0) return
  try {
    const database = await open(activeUser)
    const kept = messages.slice(-MAX_MESSAGES_PER_THREAD)
    const entry: CachedThread = {
      conversation,
      messages: kept,
      hasMoreBefore: hasMoreBefore || kept.length < messages.length,
      cachedAt: Date.now(),
    }
    await database.put('threads', entry)
    const count = await database.count('threads')
    if (count > MAX_THREADS) {
      const tx = database.transaction('threads', 'readwrite')
      let cursor = await tx.store.index('cachedAt').openCursor()
      for (let excess = count - MAX_THREADS; cursor && excess > 0; excess--) {
        await cursor.delete()
        cursor = await cursor.continue()
      }
      await tx.done
    }
  } catch {
    /* no offline copy */
  }
}

export async function loadThread(conversationId: string): Promise<CachedThread | null> {
  if (!activeUser) return null
  try {
    return ((await (await open(activeUser)).get('threads', conversationId)) as CachedThread | undefined) ?? null
  } catch {
    return null
  }
}

export async function removeThread(conversationId: string): Promise<void> {
  if (!activeUser) return
  try {
    await (await open(activeUser)).delete('threads', conversationId)
  } catch {
    /* nothing to remove */
  }
}

/** Sign-out: drop this user's offline copy entirely. */
export async function clearCache(): Promise<void> {
  const userId = activeUser
  activeUser = null
  try {
    localStorage.removeItem(LAST_USER_KEY)
  } catch {
    /* storage unavailable */
  }
  if (!userId) return
  try {
    if (db && dbUser === userId) (await db).close()
    db = null
    dbUser = null
    indexedDB.deleteDatabase(`ai-chat-${userId}`)
  } catch {
    /* nothing to delete */
  }
}
