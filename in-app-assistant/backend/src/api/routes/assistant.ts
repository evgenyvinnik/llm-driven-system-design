/**
 * Assistant API: start a turn, follow its events, answer its client tool
 * requests and confirmations, cancel it.
 */
import { createHash, randomUUID } from 'node:crypto'
import { Router } from 'express'
import { z } from 'zod'
import { requireAuth } from '../../shared/auth.js'
import { config } from '../../shared/config.js'
import { pool } from '../../shared/db.js'
import { asyncHandler, HttpError } from '../../shared/errors.js'
import { idParam, uuidParam } from '../../shared/ids.js'
import { enforceRateLimit } from '../../shared/rate-limit.js'
import { cancelTurn, resolveAction, submitClientResult } from '../../orchestrator/resume.js'
import { startDrive } from '../../orchestrator/run-turn.js'
import { loadTurn, type Turn } from '../../orchestrator/turn-store.js'
import { turnDto } from '../services/dto.js'
import { streamTurnEvents } from '../services/turn-stream.js'

export const assistantRouter = Router()
assistantRouter.use(requireAuth)

const APPS = ['mail', 'docs', 'calendar'] as const

async function ownTurn(turnId: unknown, userId: string): Promise<Turn> {
  const turn = await loadTurn(uuidParam(turnId, 'Turn'))
  if (!turn || turn.user_id !== userId) throw new HttpError(404, 'NOT_FOUND', 'Turn not found')
  return turn
}

function conversationDto(row: { id: string; app: string; title: string | null; created_at: Date }) {
  return { id: row.id, app: row.app, title: row.title, createdAt: row.created_at.toISOString() }
}

assistantRouter.get(
  '/conversations/current',
  asyncHandler(async (req, res) => {
    const app = z.enum(APPS).parse(req.query.app)
    const { rows } = await pool.query<{ id: string; app: string; title: string | null; created_at: Date }>(
      'SELECT id, app, title, created_at FROM conversations WHERE user_id = $1 AND app = $2 AND NOT is_eval ORDER BY updated_at DESC LIMIT 1',
      [req.user!.id, app],
    )
    if (!rows[0]) {
      res.json({ conversation: null, turns: [] })
      return
    }
    const { rows: turns } = await pool.query<Turn>('SELECT * FROM turns WHERE conversation_id = $1 ORDER BY seq DESC LIMIT 30', [rows[0].id])
    res.json({ conversation: conversationDto(rows[0]), turns: await Promise.all(turns.reverse().map(turnDto)) })
  }),
)

assistantRouter.post(
  '/conversations',
  asyncHandler(async (req, res) => {
    const { app } = z.object({ app: z.enum(APPS) }).parse(req.body)
    const { rows } = await pool.query<{ id: string; app: string; title: string | null; created_at: Date }>(
      'INSERT INTO conversations (id, user_id, app) VALUES ($1, $2, $3) RETURNING id, app, title, created_at',
      [randomUUID(), req.user!.id, app],
    )
    res.status(201).json({ conversation: conversationDto(rows[0]) })
  }),
)

const openDocumentSchema = z.object({
  doc_id: z.string().max(40),
  title: z.string().max(200),
  version: z.number().int().optional(),
  selection: z.array(z.string().max(20)).max(50).optional(),
  outline: z.array(z.object({ id: z.string().max(20), kind: z.string().max(20), text: z.string().max(200) })).max(200).optional(),
})

const createTurnSchema = z.object({
  conversationId: z.string().uuid().optional(),
  app: z.enum(APPS),
  text: z.string().trim().min(1).max(4000),
  clientContext: z.object({ openDocument: openDocumentSchema.optional(), openMessage: z.string().max(40).optional() }).default({}),
})

/**
 * Creates a turn and starts running it on this instance. The client sends an
 * Idempotency-Key, so a retried POST (lost response, double click) returns
 * the same turn instead of asking the model twice.
 */
assistantRouter.post(
  '/turns',
  asyncHandler(async (req, res) => {
    const userId = req.user!.id
    const key = req.header('Idempotency-Key')
    if (!key || key.length > 100) throw new HttpError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Send an Idempotency-Key header')
    const body = createTurnSchema.parse(req.body)
    const hash = createHash('sha256').update(JSON.stringify([body.conversationId ?? null, body.app, body.text])).digest('hex')

    const existing = await pool.query<Turn>('SELECT * FROM turns WHERE user_id = $1 AND idempotency_key = $2', [userId, key])
    if (existing.rows[0]) {
      if (existing.rows[0].request_hash !== hash) throw new HttpError(422, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was used for a different request')
      res.status(200).json({ turn: await turnDto(existing.rows[0]), replayed: true })
      return
    }
    await enforceRateLimit(`turns:${userId}`, config.turn.turnsPerMinutePerUser, 60)

    let conversationId = body.conversationId
    if (conversationId) {
      const { rows } = await pool.query('SELECT 1 FROM conversations WHERE id = $1 AND user_id = $2 AND app = $3', [conversationId, userId, body.app])
      if (!rows[0]) throw new HttpError(404, 'NOT_FOUND', 'Conversation not found')
    } else {
      conversationId = randomUUID()
      await pool.query('INSERT INTO conversations (id, user_id, app, title) VALUES ($1, $2, $3, $4)', [conversationId, userId, body.app, body.text.slice(0, 80)])
    }

    let turn: Turn
    try {
      const { rows } = await pool.query<Turn>(
        `INSERT INTO turns (id, conversation_id, user_id, seq, idempotency_key, request_hash, user_text, client_context, status,
                            lease_owner, lease_expires_at)
         SELECT $1, $2, $3, COALESCE(MAX(seq), 0) + 1, $4, $5, $6, $7, 'running', $8, now() + make_interval(secs => $9)
           FROM turns WHERE conversation_id = $2
         RETURNING *`,
        [randomUUID(), conversationId, userId, key, hash, body.text, JSON.stringify(body.clientContext), config.instanceId, config.turn.leaseSeconds],
      )
      turn = rows[0]
    } catch (err) {
      const code = (err as { code?: string; constraint?: string }).code
      const constraint = (err as { constraint?: string }).constraint
      if (code === '23505' && constraint === 'turns_one_active') {
        const { rows } = await pool.query<{ id: string }>(
          `SELECT id FROM turns WHERE conversation_id = $1 AND status IN ('running', 'waiting_client', 'waiting_confirmation')`,
          [conversationId],
        )
        throw new HttpError(409, 'TURN_IN_PROGRESS', 'The assistant is still working on the previous request', { turnId: rows[0]?.id })
      }
      if (code === '23505') throw new HttpError(409, 'RETRY', 'Another request was submitted at the same moment; try again')
      throw err
    }
    await pool.query('UPDATE conversations SET updated_at = now() WHERE id = $1', [conversationId])
    void startDrive(turn.id)
    res.status(202).json({ turn: await turnDto(turn), replayed: false })
  }),
)

assistantRouter.get(
  '/turns/:id',
  asyncHandler(async (req, res) => {
    res.json({ turn: await turnDto(await ownTurn(req.params.id, req.user!.id)) })
  }),
)

assistantRouter.get(
  '/turns/:id/events',
  asyncHandler(async (req, res) => {
    const turn = await ownTurn(req.params.id, req.user!.id)
    await streamTurnEvents(req, res, turn, req.header('Last-Event-ID') ?? (req.query.after as string | undefined))
  }),
)

assistantRouter.get(
  '/turns/:id/steps',
  asyncHandler(async (req, res) => {
    const turn = await ownTurn(req.params.id, req.user!.id)
    const { rows } = await pool.query(
      'SELECT id, step, kind, name, detail, latency_ms, input_tokens, output_tokens, cache_read_tokens, created_at FROM turn_steps WHERE turn_id = $1 ORDER BY id',
      [turn.id],
    )
    res.json({
      steps: rows.map((r) => ({
        id: Number(r.id),
        step: r.step,
        kind: r.kind,
        name: r.name,
        detail: r.detail,
        latencyMs: r.latency_ms,
        inputTokens: r.input_tokens,
        outputTokens: r.output_tokens,
        cacheReadTokens: r.cache_read_tokens,
        createdAt: r.created_at.toISOString(),
      })),
    })
  }),
)

const toolResultSchema = z.object({
  callId: z.string().min(1).max(100),
  output: z.record(z.unknown()).optional(),
  error: z.string().max(2000).optional(),
})

assistantRouter.post(
  '/turns/:id/tool-results',
  asyncHandler(async (req, res) => {
    const turn = await ownTurn(req.params.id, req.user!.id)
    await submitClientResult(turn.id, req.user!.id, toolResultSchema.parse(req.body))
    res.status(202).json({ ok: true })
  }),
)

assistantRouter.post(
  '/turns/:id/cancel',
  asyncHandler(async (req, res) => {
    const turn = await ownTurn(req.params.id, req.user!.id)
    const status = await cancelTurn(turn.id, req.user!.id)
    res.status(202).json({ status })
  }),
)

for (const [path, approve] of [
  ['confirm', true],
  ['decline', false],
] as const) {
  assistantRouter.post(
    `/actions/:id/${path}`,
    asyncHandler(async (req, res) => {
      const result = await resolveAction(idParam(req.params.id, 'act', 'Action'), req.user!.id, approve)
      res.status(202).json(result)
    }),
  )
}
