/**
 * Hazards: list, detail (with the event timeline and correlation evidence) and
 * commands. Commands carry a client command id (idempotency) and the version
 * the person saw.
 */
import { Router } from 'express'
import { z } from 'zod'
import { requireAuth } from '../../shared/auth.js'
import { asyncHandler } from '../../shared/errors.js'
import { commandRequestSchema, executeCommand } from '../services/commands.js'
import { hazardDetail, hazards } from '../services/queries.js'

export const hazardsRouter = Router()
hazardsRouter.use(requireAuth)

hazardsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const status = z.enum(['open', 'closed', 'all']).catch('open').parse(req.query.status)
    res.json({ hazards: await hazards(status) })
  }),
)

hazardsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json(await hazardDetail(z.string().uuid().parse(req.params.id)))
  }),
)

hazardsRouter.post(
  '/:id/commands',
  asyncHandler(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id)
    const body = commandRequestSchema.parse(req.body)
    const result = await executeCommand(req.user!, id, body.commandId, body.command, body.seenVersion)
    res.status(result.replayed ? 200 : 201).json(result)
  }),
)
