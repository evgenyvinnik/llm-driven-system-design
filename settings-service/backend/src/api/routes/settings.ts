/**
 * The user-facing contract:
 *
 *   GET   /api/v1/definitions        catalog (active + deprecated keys)
 *   GET   /api/v1/me/settings        effective value, source and lock per key; ETag = user revision
 *   PATCH /api/v1/me/settings        merge patch {key: value | null}; If-Match required
 *   GET   /api/v1/me/history         this user's change log
 *
 * PATCH responses: 200 (applied or no-op, full document), 409 (stale same-key
 * write, with conflicts and the current document), 412 (If-Match ahead of the
 * server), 422 (per-field errors, nothing saved), 428 (no If-Match).
 * @module api/routes/settings
 */
import { Router } from 'express'
import { requireAuth } from '../../shared/auth.js'
import { takeDrop } from '../../shared/chaos.js'
import { config } from '../../shared/config.js'
import { asyncHandler, HttpError } from '../../shared/errors.js'
import { logger } from '../../shared/logger.js'
import { chaosDropped } from '../../shared/metrics.js'
import { listDefinitions } from '../../services/catalog-service.js'
import { applyUserPatch, getEffectiveDoc, getUserHistory } from '../../services/settings-service.js'
import { clientIdentity, etag, limitPatches, requireIfMatch } from '../http.js'

export const settingsRouter = Router()

const MAX_KEYS_PER_PATCH = 100

settingsRouter.get(
  '/definitions',
  requireAuth,
  asyncHandler(async (req, res) => {
    const includeRetired = req.query.includeRetired === '1' && req.user!.role !== 'member'
    res.json(await listDefinitions(includeRetired))
  }),
)

settingsRouter.get(
  '/me/settings',
  requireAuth,
  asyncHandler(async (req, res) => {
    const doc = await getEffectiveDoc(req.user!)
    res.set({ ETag: etag(doc.revision), 'Cache-Control': 'no-store' })
    res.json(doc)
  }),
)

settingsRouter.patch(
  '/me/settings',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.user!
    const body: unknown = req.body
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new HttpError(400, 'BAD_PATCH', 'Body must be a JSON object of setting keys to values (null resets a key)')
    }
    const patch = body as Record<string, unknown>
    const count = Object.keys(patch).length
    if (count === 0) throw new HttpError(400, 'EMPTY_PATCH', 'Patch must contain at least one key')
    if (count > MAX_KEYS_PER_PATCH) throw new HttpError(400, 'PATCH_TOO_LARGE', `At most ${MAX_KEYS_PER_PATCH} keys per patch`)
    const baseRevision = requireIfMatch(req)
    await limitPatches(user.id)

    const result = await applyUserPatch(user, patch, { baseRevision, ...clientIdentity(req) })

    // Dev chaos: the transaction has committed and the event is published; now lose the response.
    if (config.chaosEnabled && (await takeDrop(user.id))) {
      chaosDropped.inc()
      logger.warn({ user: user.username, revision: result.revision }, 'chaos: dropping PATCH response after commit')
      req.socket.destroy()
      return
    }
    res.set({ ETag: etag(result.revision), 'Cache-Control': 'no-store' })
    res.json(result)
  }),
)

settingsRouter.get(
  '/me/history',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ changes: await getUserHistory(req.user!) })
  }),
)
