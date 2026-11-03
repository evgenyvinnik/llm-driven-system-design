/**
 * Creating, replaying and cancelling generations.
 *
 * Every user action that asks the model for an answer (a new message, an edit,
 * a regeneration) is one POST carrying a client-generated Idempotency-Key. The
 * key is stored on the generation, so a retry after a lost response returns
 * the generation that already exists instead of starting a second one, and
 * reusing a key for a different request is rejected.
 *
 * Within a conversation only one generation may be in flight. The conversation
 * row is locked while checking, and a partial unique index backs that up, so
 * two devices submitting at the same instant get one generation and one 409
 * that names it (the losing device attaches to it instead).
 */
import { createHash } from 'node:crypto'
import pg from 'pg'
import { z } from 'zod'
import type { SessionUser } from '../../shared/auth.js'
import { redis } from '../../shared/cache.js'
import { DEFAULT_MODEL, MODEL_IDS } from '../../shared/catalog.js'
import { config } from '../../shared/config.js'
import { titleFromMessage } from '../../shared/context.js'
import { pool, type Queryable } from '../../shared/db.js'
import { HttpError } from '../../shared/errors.js'
import {
  appendGenerationEvent,
  emptyUsage,
  enqueueGeneration,
  GENERATION_CANCEL_CHANNEL,
} from '../../shared/generation-events.js'
import { logger } from '../../shared/logger.js'
import { generationsCreated, generationsFinished, idempotentReplays } from '../../shared/metrics.js'
import { enforceRateLimit } from '../../shared/rate-limit.js'
import { publishUserEvent } from '../../shared/user-events.js'
import {
  CONVERSATION_SELECT,
  serializeConversation,
  serializeGeneration,
  serializeMessage,
  type ConversationRow,
  type GenerationRow,
  type MessageRow,
} from './serialize.js'
import { loadConversationForUser } from './threads.js'

const content = z.string().trim().min(1, 'The message is empty').max(32_000, 'The message is too long')

export const newConversationSchema = z.object({ content, model: z.enum(MODEL_IDS).optional() }).strict()

export const submitMessageSchema = z
  .object({
    content,
    /** The assistant message being replied to; null starts a new root (editing the first message). */
    parentMessageId: z.string().uuid().nullable(),
    /** Set when this message replaces an earlier user message (an edit creates a sibling branch). */
    editOfMessageId: z.string().uuid().optional(),
    model: z.enum(MODEL_IDS).optional(),
  })
  .strict()

export const regenerateSchema = z.object({ model: z.enum(MODEL_IDS).optional() }).strict()

type Op =
  | { op: 'new-conversation'; content: string; model?: string }
  | { op: 'message'; conversationId: string; content: string; parentMessageId: string | null; editOfMessageId?: string; model?: string }
  | { op: 'regenerate'; conversationId: string; userMessageId: string; model?: string }

export function requestHash(op: Op): string {
  return createHash('sha256').update(JSON.stringify(op)).digest('hex')
}

export interface GenerationResult {
  conversation: ReturnType<typeof serializeConversation>
  userMessage: ReturnType<typeof serializeMessage>
  assistantMessage: ReturnType<typeof serializeMessage>
  generation: ReturnType<typeof serializeGeneration>
  replayed: boolean
}

export async function loadGenerationForUser(db: Queryable, generationId: string, user: SessionUser): Promise<GenerationRow> {
  const { rows } = await db.query<GenerationRow>(
    `SELECT g.* FROM generations g JOIN conversations c ON c.id = g.conversation_id
      WHERE g.id = $1 AND c.user_id = $2 AND c.deleted_at IS NULL`,
    [generationId, user.id],
  )
  if (rows.length === 0) throw new HttpError(404, 'NOT_FOUND', 'Generation not found')
  return rows[0]
}

/** Rebuilds the full POST response for a generation (used by both a fresh create and a replay). */
async function resultFor(generation: GenerationRow, replayed: boolean): Promise<GenerationResult> {
  const [conv, messages, siblings] = await Promise.all([
    pool.query<ConversationRow>(`${CONVERSATION_SELECT} WHERE c.id = $1`, [generation.conversation_id]),
    pool.query<MessageRow>('SELECT * FROM messages WHERE id = ANY($1::uuid[])', [
      [generation.user_message_id, generation.assistant_message_id],
    ]),
    pool.query<{ id: string; parent_id: string | null }>(
      `SELECT m.id, m.parent_id FROM messages m
        JOIN messages t ON t.id = ANY($1::uuid[]) AND t.conversation_id = m.conversation_id
         AND m.parent_id IS NOT DISTINCT FROM t.parent_id
       ORDER BY m.created_at, m.id`,
      [[generation.user_message_id, generation.assistant_message_id]],
    ),
  ])
  const siblingIds = (row: MessageRow) =>
    [...new Set(siblings.rows.filter((s) => s.parent_id === row.parent_id).map((s) => s.id))]
  const user = messages.rows.find((m) => m.id === generation.user_message_id)!
  const assistant = messages.rows.find((m) => m.id === generation.assistant_message_id)!
  return {
    conversation: serializeConversation(conv.rows[0]),
    userMessage: serializeMessage(user, siblingIds(user), null),
    assistantMessage: serializeMessage(assistant, siblingIds(assistant), generation),
    generation: serializeGeneration(generation),
    replayed,
  }
}

async function findByKey(userId: string, key: string): Promise<GenerationRow | null> {
  const { rows } = await pool.query<GenerationRow>(
    'SELECT * FROM generations WHERE user_id = $1 AND idempotency_key = $2',
    [userId, key],
  )
  return rows[0] ?? null
}

async function replay(existing: GenerationRow, hash: string): Promise<GenerationResult> {
  if (existing.request_hash !== hash) {
    throw new HttpError(422, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different request', {
      generationId: existing.id,
    })
  }
  idempotentReplays.inc()
  return resultFor(existing, true)
}

async function enforceLimits(user: SessionUser): Promise<void> {
  await enforceRateLimit(`generations:${user.id}`, config.generationsPerMinutePerUser, 60)
  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(*) FROM generations WHERE user_id = $1 AND status IN ('accepted', 'running')`,
    [user.id],
  )
  if (Number(rows[0].count) >= config.maxActiveGenerationsPerUser) {
    throw new HttpError(
      429,
      'TOO_MANY_ACTIVE_GENERATIONS',
      `You already have ${config.maxActiveGenerationsPerUser} answers being written; wait for one to finish or stop one`,
    )
  }
}

async function assertNothingInFlight(db: Queryable, conversationId: string): Promise<void> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM generations WHERE conversation_id = $1 AND status IN ('accepted', 'running')`,
    [conversationId],
  )
  if (rows.length > 0) {
    throw new HttpError(409, 'GENERATION_IN_PROGRESS', 'An answer is already being written in this conversation', {
      generationId: rows[0].id,
    })
  }
}

interface Insert {
  conversationId: string
  userId: string
  kind: GenerationRow['kind']
  model: string
  key: string
  hash: string
  userMessageId: string
  assistantParentDepth: number
}

/** Inserts the assistant placeholder and its generation; returns null if the key was taken concurrently. */
async function insertGeneration(client: pg.PoolClient, ins: Insert): Promise<GenerationRow | null> {
  const assistant = await client.query<{ id: string }>(
    `INSERT INTO messages (conversation_id, parent_id, role, content, depth)
     VALUES ($1, $2, 'assistant', '', $3) RETURNING id`,
    [ins.conversationId, ins.userMessageId, ins.assistantParentDepth + 1],
  )
  const assistantId = assistant.rows[0].id
  const gen = await client.query<GenerationRow>(
    `INSERT INTO generations (conversation_id, user_id, user_message_id, assistant_message_id, kind, model,
                              idempotency_key, request_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (user_id, idempotency_key) DO NOTHING
     RETURNING *`,
    [ins.conversationId, ins.userId, ins.userMessageId, assistantId, ins.kind, ins.model, ins.key, ins.hash],
  )
  if (gen.rows.length === 0) return null
  await client.query('UPDATE conversations SET current_leaf_id = $2, updated_at = now(), model = $3 WHERE id = $1', [
    ins.conversationId,
    assistantId,
    ins.model,
  ])
  return gen.rows[0]
}

const isActiveConflict = (err: unknown) =>
  err instanceof pg.DatabaseError && err.code === '23505' && err.constraint === 'generations_one_active_per_conversation'

/**
 * Runs the insert transaction and handles both races: the same key arriving
 * twice (replay the winner) and two keys for one conversation (409).
 */
async function createInTransaction(
  user: SessionUser,
  key: string,
  hash: string,
  conversationId: string | null,
  body: (client: pg.PoolClient) => Promise<GenerationRow | null>,
): Promise<GenerationResult> {
  const existing = await findByKey(user.id, key)
  if (existing) return replay(existing, hash)
  await enforceLimits(user)

  const client = await pool.connect()
  let created: GenerationRow | null = null
  try {
    await client.query('BEGIN')
    created = await body(client)
    if (created) await client.query('COMMIT')
    else await client.query('ROLLBACK')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined)
    // Only reachable if the row lock was bypassed; the index still guarantees one answer at a time.
    if (isActiveConflict(err) && conversationId) await assertNothingInFlight(pool, conversationId)
    if (isActiveConflict(err)) throw new HttpError(409, 'GENERATION_IN_PROGRESS', 'An answer is already being written')
    throw err
  } finally {
    client.release()
  }

  if (!created) {
    // A concurrent request with the same key won the insert.
    const winner = await findByKey(user.id, key)
    if (!winner) throw new HttpError(409, 'CONFLICT', 'Concurrent request; retry')
    return replay(winner, hash)
  }

  generationsCreated.inc({ model: created.model, kind: created.kind })
  try {
    await appendGenerationEvent(redis, created.id, { type: 'status', status: 'accepted', at: new Date().toISOString() })
    await enqueueGeneration(redis, created.id)
  } catch (err) {
    // The generation is durable in PostgreSQL; the executor sweeper re-enqueues accepted ones.
    logger.warn({ err, generationId: created.id }, 'enqueue failed; sweeper will retry')
  }
  const result = await resultFor(created, false)
  await publishUserEvent(redis, user.id, {
    type: 'generation.created',
    conversationId: created.conversation_id,
    generationId: created.id,
    payload: { ...result, replayed: undefined },
  })
  return result
}

export async function createConversation(
  user: SessionUser,
  input: z.infer<typeof newConversationSchema>,
  key: string,
): Promise<GenerationResult> {
  const model = input.model ?? DEFAULT_MODEL
  const hash = requestHash({ op: 'new-conversation', content: input.content, model: input.model })
  return createInTransaction(user, key, hash, null, async (client) => {
    const conv = await client.query<{ id: string }>(
      'INSERT INTO conversations (user_id, title, model) VALUES ($1, $2, $3) RETURNING id',
      [user.id, titleFromMessage(input.content), model],
    )
    const conversationId = conv.rows[0].id
    const userMessage = await client.query<{ id: string }>(
      `INSERT INTO messages (conversation_id, parent_id, role, content, depth)
       VALUES ($1, NULL, 'user', $2, 0) RETURNING id`,
      [conversationId, input.content],
    )
    return insertGeneration(client, {
      conversationId,
      userId: user.id,
      kind: 'message',
      model,
      key,
      hash,
      userMessageId: userMessage.rows[0].id,
      assistantParentDepth: 0,
    })
  })
}

export async function submitMessage(
  user: SessionUser,
  conversationId: string,
  input: z.infer<typeof submitMessageSchema>,
  key: string,
): Promise<GenerationResult> {
  const hash = requestHash({ op: 'message', conversationId, ...input })
  return createInTransaction(user, key, hash, conversationId, async (client) => {
    const conversation = await loadConversationForUser(client, conversationId, user, { forUpdate: true })
    await assertNothingInFlight(client, conversationId)

    let depth = 0
    if (input.parentMessageId) {
      const { rows } = await client.query<{ role: string; depth: number }>(
        'SELECT role, depth FROM messages WHERE id = $1 AND conversation_id = $2',
        [input.parentMessageId, conversationId],
      )
      if (rows.length === 0) throw new HttpError(404, 'NOT_FOUND', 'The message being replied to was not found')
      if (rows[0].role !== 'assistant') {
        throw new HttpError(422, 'INVALID_PARENT', 'A user message must follow an assistant message')
      }
      depth = rows[0].depth + 1
    }
    if (input.editOfMessageId) {
      const { rows } = await client.query<{ role: string; parent_id: string | null }>(
        'SELECT role, parent_id FROM messages WHERE id = $1 AND conversation_id = $2',
        [input.editOfMessageId, conversationId],
      )
      if (rows.length === 0 || rows[0].role !== 'user' || rows[0].parent_id !== input.parentMessageId) {
        throw new HttpError(422, 'INVALID_EDIT', 'An edit must replace a user message under the same parent')
      }
    }

    const userMessage = await client.query<{ id: string }>(
      `INSERT INTO messages (conversation_id, parent_id, role, content, depth)
       VALUES ($1, $2, 'user', $3, $4) RETURNING id`,
      [conversationId, input.parentMessageId, input.content, depth],
    )
    return insertGeneration(client, {
      conversationId,
      userId: user.id,
      kind: input.editOfMessageId ? 'edit' : 'message',
      model: input.model ?? conversation.model,
      key,
      hash,
      userMessageId: userMessage.rows[0].id,
      assistantParentDepth: depth,
    })
  })
}

/** A new answer to an existing user message: a new generation and a new assistant sibling. */
export async function regenerate(
  user: SessionUser,
  conversationId: string,
  userMessageId: string,
  input: z.infer<typeof regenerateSchema>,
  key: string,
): Promise<GenerationResult> {
  const hash = requestHash({ op: 'regenerate', conversationId, userMessageId, model: input.model })
  return createInTransaction(user, key, hash, conversationId, async (client) => {
    const conversation = await loadConversationForUser(client, conversationId, user, { forUpdate: true })
    await assertNothingInFlight(client, conversationId)
    const { rows } = await client.query<{ role: string; depth: number }>(
      'SELECT role, depth FROM messages WHERE id = $1 AND conversation_id = $2',
      [userMessageId, conversationId],
    )
    if (rows.length === 0) throw new HttpError(404, 'NOT_FOUND', 'Message not found')
    if (rows[0].role !== 'user') throw new HttpError(422, 'INVALID_TARGET', 'Regenerate answers a user message')
    return insertGeneration(client, {
      conversationId,
      userId: user.id,
      kind: 'regenerate',
      model: input.model ?? conversation.model,
      key,
      hash,
      userMessageId,
      assistantParentDepth: rows[0].depth,
    })
  })
}

/**
 * Stop. An accepted generation is cancelled immediately. A running one is
 * flagged and its executor is signalled, which aborts the upstream model
 * request; whichever of "cancelled" or "completed" is written first wins, and
 * the caller sees the outcome on the generation's event stream.
 */
export async function cancelGeneration(user: SessionUser, generationId: string): Promise<GenerationRow> {
  const gen = await loadGenerationForUser(pool, generationId, user)

  const accepted = await pool.query<GenerationRow>(
    `UPDATE generations SET status = 'cancelled', cancel_requested_at = now(), finished_at = now(), finish_reason = 'cancelled'
      WHERE id = $1 AND status = 'accepted'
      RETURNING *`,
    [generationId],
  )
  if (accepted.rows.length > 0) {
    await appendGenerationEvent(redis, generationId, {
      type: 'end',
      status: 'cancelled',
      outputTruncated: false,
      finishReason: 'cancelled',
      errorCode: null,
      errorMessage: null,
      usage: emptyUsage(),
      at: new Date().toISOString(),
    })
    await publishUserEvent(redis, user.id, {
      type: 'generation.finished',
      conversationId: gen.conversation_id,
      generationId,
      assistantMessageId: gen.assistant_message_id,
      status: 'cancelled',
    })
    generationsFinished.inc({ model: gen.model, status: 'cancelled' })
  } else {
    const running = await pool.query(
      `UPDATE generations SET cancel_requested_at = coalesce(cancel_requested_at, now())
        WHERE id = $1 AND status = 'running'
        RETURNING id`,
      [generationId],
    )
    if (running.rows.length > 0) await redis.publish(GENERATION_CANCEL_CHANNEL, generationId)
  }
  return loadGenerationForUser(pool, generationId, user)
}
