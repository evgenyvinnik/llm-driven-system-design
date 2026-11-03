/**
 * Reading the message tree.
 *
 * The visible thread is the path from a leaf up to the root. Long threads are
 * paged from the leaf backwards with a recursive walk up parent pointers, so
 * opening a 5,000-message conversation reads one page, not the whole tree.
 * Each message carries its siblings (children of the same parent, oldest
 * first), which is everything the client needs to draw "‹ 2/3 ›".
 */
import type { SessionUser } from '../../shared/auth.js'
import { pool, type Queryable } from '../../shared/db.js'
import { HttpError } from '../../shared/errors.js'
import {
  CONVERSATION_SELECT,
  serializeConversation,
  serializeMessage,
  type ConversationRow,
  type GenerationRow,
  type MessageRow,
} from './serialize.js'

export const PAGE_SIZE = 40
export const MAX_PAGE_SIZE = 200

/**
 * Ownership check used by every conversation, message and generation route.
 * Another user's conversation is reported as not found, so IDs can't be probed.
 */
export async function loadConversationForUser(
  db: Queryable,
  conversationId: string,
  user: SessionUser,
  opts: { forUpdate?: boolean } = {},
): Promise<ConversationRow> {
  const { rows } = await db.query<ConversationRow>(
    opts.forUpdate
      ? `SELECT * FROM conversations c WHERE c.id = $1 AND c.user_id = $2 AND c.deleted_at IS NULL FOR UPDATE`
      : `${CONVERSATION_SELECT} WHERE c.id = $1 AND c.user_id = $2 AND c.deleted_at IS NULL`,
    [conversationId, user.id],
  )
  if (rows.length === 0) throw new HttpError(404, 'NOT_FOUND', 'Conversation not found')
  return rows[0]
}

/** Messages from `startId` up towards the root, at most `limit`, returned oldest first. */
async function walkUp(
  db: Queryable,
  conversationId: string,
  startId: string,
  limit: number,
): Promise<{ rows: MessageRow[]; hasMoreBefore: boolean }> {
  const { rows } = await db.query<MessageRow & { n: number }>(
    `WITH RECURSIVE path AS (
       SELECT m.*, 1 AS n FROM messages m WHERE m.id = $1 AND m.conversation_id = $2
       UNION ALL
       SELECT m.*, p.n + 1 FROM messages m JOIN path p ON m.id = p.parent_id WHERE p.n <= $3
     )
     SELECT id, conversation_id, parent_id, role, content, depth, created_at, n FROM path ORDER BY n DESC`,
    [startId, conversationId, limit],
  )
  const hasMoreBefore = rows.length > limit
  return { rows: hasMoreBefore ? rows.slice(1) : rows, hasMoreBefore }
}

async function decorate(db: Queryable, conversationId: string, rows: MessageRow[]) {
  if (rows.length === 0) return []
  const parentIds = [...new Set(rows.map((r) => r.parent_id).filter((id): id is string => id !== null))]
  const includesRoot = rows.some((r) => r.parent_id === null)
  const [siblings, generations] = await Promise.all([
    db.query<{ id: string; parent_id: string | null }>(
      `SELECT id, parent_id FROM messages
        WHERE conversation_id = $1 AND (parent_id = ANY($2::uuid[]) OR ($3 AND parent_id IS NULL))
        ORDER BY created_at, id`,
      [conversationId, parentIds, includesRoot],
    ),
    db.query<GenerationRow>('SELECT * FROM generations WHERE assistant_message_id = ANY($1::uuid[])', [
      rows.filter((r) => r.role === 'assistant').map((r) => r.id),
    ]),
  ])
  const byParent = new Map<string, string[]>()
  for (const s of siblings.rows) {
    const key = s.parent_id ?? 'root'
    const list = byParent.get(key) ?? []
    list.push(s.id)
    byParent.set(key, list)
  }
  const genByMessage = new Map(generations.rows.map((g) => [g.assistant_message_id, g]))
  return rows.map((r) => serializeMessage(r, byParent.get(r.parent_id ?? 'root') ?? [r.id], genByMessage.get(r.id) ?? null))
}

/** The page of the visible thread that ends at `leafId`. */
export async function loadThreadPage(db: Queryable, conversationId: string, leafId: string | null, limit = PAGE_SIZE) {
  if (!leafId) return { messages: [], hasMoreBefore: false }
  const { rows, hasMoreBefore } = await walkUp(db, conversationId, leafId, limit)
  return { messages: await decorate(db, conversationId, rows), hasMoreBefore }
}

/** Older messages: the ancestors of `beforeId` (exclusive), newest page first. */
export async function loadOlder(db: Queryable, conversationId: string, beforeId: string, limit = PAGE_SIZE) {
  const { rows } = await db.query<{ parent_id: string | null }>(
    'SELECT parent_id FROM messages WHERE id = $1 AND conversation_id = $2',
    [beforeId, conversationId],
  )
  if (rows.length === 0) throw new HttpError(404, 'NOT_FOUND', 'Message not found')
  return loadThreadPage(db, conversationId, rows[0].parent_id, limit)
}

/**
 * The newest message in the subtree under `messageId`. Children are always
 * newer than their parents, so the newest descendant is a leaf, and showing
 * the path to it is "the latest state of that branch".
 */
export async function latestLeafUnder(db: Queryable, conversationId: string, messageId: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `WITH RECURSIVE sub AS (
       SELECT id, created_at, depth FROM messages WHERE id = $1 AND conversation_id = $2
       UNION ALL
       SELECT m.id, m.created_at, m.depth FROM messages m JOIN sub ON m.parent_id = sub.id
     )
     SELECT id FROM sub ORDER BY created_at DESC, depth DESC LIMIT 1`,
    [messageId, conversationId],
  )
  if (rows.length === 0) throw new HttpError(404, 'NOT_FOUND', 'Message not found')
  return rows[0].id
}

export async function loadConversationView(user: SessionUser, conversationId: string, limit = PAGE_SIZE) {
  const conversation = await loadConversationForUser(pool, conversationId, user)
  const page = await loadThreadPage(pool, conversationId, conversation.current_leaf_id, limit)
  return { conversation: serializeConversation(conversation), ...page }
}

/** Branch navigation: show the latest state of the branch through `messageId`, and remember it. */
export async function switchBranch(user: SessionUser, conversationId: string, messageId: string, limit = PAGE_SIZE) {
  await loadConversationForUser(pool, conversationId, user)
  const leafId = await latestLeafUnder(pool, conversationId, messageId)
  await pool.query('UPDATE conversations SET current_leaf_id = $2 WHERE id = $1', [conversationId, leafId])
  return loadConversationView(user, conversationId, limit)
}
