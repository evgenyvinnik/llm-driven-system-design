import { Router } from 'express'
import { requireAuth } from '../../shared/auth.js'
import { pool } from '../../shared/db.js'
import { asyncHandler } from '../../shared/errors.js'
import { uuidParam } from '../../shared/ids.js'
import { cancelGeneration, loadGenerationForUser } from '../services/generations.js'
import { streamGenerationEvents } from '../services/generation-stream.js'
import { serializeGeneration, type GenerationRow } from '../services/serialize.js'

export const generationsRouter = Router()
generationsRouter.use(requireAuth)

/** The caller's in-flight generations across all conversations, so a refreshed tab can reattach to each. */
generationsRouter.get(
  '/active',
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query<GenerationRow & { title: string }>(
      `SELECT g.*, c.title FROM generations g JOIN conversations c ON c.id = g.conversation_id
        WHERE g.user_id = $1 AND g.status IN ('accepted', 'running') AND c.deleted_at IS NULL
        ORDER BY g.created_at`,
      [req.user!.id],
    )
    res.json({ generations: rows.map((r) => ({ ...serializeGeneration(r), conversationTitle: r.title })) })
  }),
)

generationsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const gen = await loadGenerationForUser(pool, uuidParam(req.params.id, 'Generation'), req.user!)
    res.json({ generation: serializeGeneration(gen) })
  }),
)

/** Stop: aborts the upstream model request, not just the rendering. */
generationsRouter.post(
  '/:id/cancel',
  asyncHandler(async (req, res) => {
    const gen = await cancelGeneration(req.user!, uuidParam(req.params.id, 'Generation'))
    // 202 while the executor still has to acknowledge; 200 once the outcome is final.
    res.status(gen.status === 'running' ? 202 : 200).json({ generation: serializeGeneration(gen) })
  }),
)

/** SSE. Resumes after Last-Event-ID (header, or ?after= for clients that can't set headers). */
generationsRouter.get(
  '/:id/events',
  asyncHandler(async (req, res) => {
    const gen = await loadGenerationForUser(pool, uuidParam(req.params.id, 'Generation'), req.user!)
    const lastEventId = req.get('Last-Event-ID') ?? (typeof req.query.after === 'string' ? req.query.after : undefined)
    await streamGenerationEvents(req, res, gen, lastEventId)
  }),
)
