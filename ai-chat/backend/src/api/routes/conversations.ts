/**
 * Conversations and the message tree. Every route loads the conversation
 * through its owner (`loadConversationForUser`), so another user's
 * conversation is a 404 whatever the route.
 */
import { Router, type Request } from 'express'
import { z } from 'zod'
import { requireAuth } from '../../shared/auth.js'
import { redis } from '../../shared/cache.js'
import { pool } from '../../shared/db.js'
import { asyncHandler, HttpError } from '../../shared/errors.js'
import { uuidParam } from '../../shared/ids.js'
import { publishUserEvent } from '../../shared/user-events.js'
import {
  createConversation,
  newConversationSchema,
  regenerate,
  regenerateSchema,
  submitMessage,
  submitMessageSchema,
  type GenerationResult,
} from '../services/generations.js'
import { CONVERSATION_SELECT, serializeConversation, type ConversationRow } from '../services/serialize.js'
import {
  loadConversationForUser,
  loadConversationView,
  loadOlder,
  MAX_PAGE_SIZE,
  PAGE_SIZE,
  switchBranch,
} from '../services/threads.js'
import { GENERATION_CANCEL_CHANNEL } from '../../shared/generation-events.js'

export const conversationsRouter = Router()
conversationsRouter.use(requireAuth)

/** One key per user action (the Send click, the Regenerate click). Required on every POST that asks the model. */
function idempotencyKey(req: Request): string {
  const key = req.get('Idempotency-Key')
  if (!key || key.length > 100) {
    throw new HttpError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Send an Idempotency-Key header (1-100 characters)')
  }
  return key
}

function pageSize(raw: unknown): number {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? Math.min(n, MAX_PAGE_SIZE) : PAGE_SIZE
}

function sendResult(res: import('express').Response, result: GenerationResult) {
  if (result.replayed) res.setHeader('Idempotent-Replayed', 'true')
  const { replayed, ...body } = result
  res.status(replayed ? 200 : 202).json(body)
}

const cursorSchema = z.object({ u: z.string(), id: z.string().uuid() })

/** The sidebar list, most recently active first, keyset-paginated on (updated_at, id). */
conversationsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const limit = Math.min(pageSize(req.query.limit), 50)
    let cursor: z.infer<typeof cursorSchema> | null = null
    if (typeof req.query.cursor === 'string') {
      try {
        cursor = cursorSchema.parse(JSON.parse(Buffer.from(req.query.cursor, 'base64url').toString('utf8')))
      } catch {
        throw new HttpError(400, 'INVALID_CURSOR', 'The cursor is malformed')
      }
    }
    const { rows } = await pool.query<ConversationRow>(
      `${CONVERSATION_SELECT}
        WHERE c.user_id = $1 AND c.deleted_at IS NULL AND c.current_leaf_id IS NOT NULL
          AND ($2::timestamptz IS NULL OR (c.updated_at, c.id) < ($2::timestamptz, $3::uuid))
        ORDER BY c.updated_at DESC, c.id DESC
        LIMIT $4`,
      [req.user!.id, cursor?.u ?? null, cursor?.id ?? null, limit + 1],
    )
    const page = rows.slice(0, limit)
    const last = page[page.length - 1]
    const nextCursor =
      rows.length > limit && last
        ? Buffer.from(JSON.stringify({ u: last.updated_cursor, id: last.id })).toString('base64url')
        : null
    res.json({ conversations: page.map(serializeConversation), nextCursor })
  }),
)

/** New chat: creates the conversation, the first message and its generation in one idempotent request. */
conversationsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const key = idempotencyKey(req)
    const input = newConversationSchema.parse(req.body)
    sendResult(res, await createConversation(req.user!, input, key))
  }),
)

conversationsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = uuidParam(req.params.id, 'Conversation')
    res.json(await loadConversationView(req.user!, id, pageSize(req.query.limit)))
  }),
)

/** Older messages on the visible path, for scrolling up through a long conversation. */
conversationsRouter.get(
  '/:id/messages',
  asyncHandler(async (req, res) => {
    const id = uuidParam(req.params.id, 'Conversation')
    await loadConversationForUser(pool, id, req.user!)
    const before = uuidParam(req.query.before, 'Message')
    res.json(await loadOlder(pool, id, before, pageSize(req.query.limit)))
  }),
)

const renameSchema = z.object({ title: z.string().trim().min(1).max(120) }).strict()

conversationsRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = uuidParam(req.params.id, 'Conversation')
    const { title } = renameSchema.parse(req.body)
    await loadConversationForUser(pool, id, req.user!)
    await pool.query('UPDATE conversations SET title = $2 WHERE id = $1', [id, title])
    const conversation = serializeConversation(await loadConversationForUser(pool, id, req.user!))
    await publishUserEvent(redis, req.user!.id, { type: 'conversation.updated', conversationId: id, payload: conversation })
    res.json({ conversation })
  }),
)

conversationsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = uuidParam(req.params.id, 'Conversation')
    await loadConversationForUser(pool, id, req.user!)
    await pool.query('UPDATE conversations SET deleted_at = now() WHERE id = $1', [id])
    // A deleted conversation must not keep spending tokens.
    const { rows } = await pool.query<{ id: string }>(
      `UPDATE generations SET cancel_requested_at = coalesce(cancel_requested_at, now())
        WHERE conversation_id = $1 AND status IN ('accepted', 'running') RETURNING id`,
      [id],
    )
    for (const row of rows) await redis.publish(GENERATION_CANCEL_CHANNEL, row.id)
    await publishUserEvent(redis, req.user!.id, { type: 'conversation.deleted', conversationId: id })
    res.status(204).end()
  }),
)

/** A new user message (or an edit, when editOfMessageId is set) and the generation answering it. */
conversationsRouter.post(
  '/:id/messages',
  asyncHandler(async (req, res) => {
    const id = uuidParam(req.params.id, 'Conversation')
    const key = idempotencyKey(req)
    const input = submitMessageSchema.parse(req.body)
    sendResult(res, await submitMessage(req.user!, id, input, key))
  }),
)

/** A new answer to an existing user message. A different key from the original request, by definition. */
conversationsRouter.post(
  '/:id/messages/:messageId/regenerate',
  asyncHandler(async (req, res) => {
    const id = uuidParam(req.params.id, 'Conversation')
    const messageId = uuidParam(req.params.messageId, 'Message')
    const key = idempotencyKey(req)
    const input = regenerateSchema.parse(req.body ?? {})
    sendResult(res, await regenerate(req.user!, id, messageId, input, key))
  }),
)

const leafSchema = z.object({ messageId: z.string().uuid() }).strict()

/** Branch navigation (‹ 2/3 ›): show the latest state of the branch through messageId. */
conversationsRouter.put(
  '/:id/leaf',
  asyncHandler(async (req, res) => {
    const id = uuidParam(req.params.id, 'Conversation')
    const { messageId } = leafSchema.parse(req.body)
    const view = await switchBranch(req.user!, id, messageId, pageSize(req.query.limit))
    res.json(view)
  }),
)
