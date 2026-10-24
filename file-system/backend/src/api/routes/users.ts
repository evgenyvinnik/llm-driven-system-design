/**
 * Users, quotas, merges, backups and restores: the admin side.
 */
import { Router } from 'express'
import { asyncHandler } from '../../shared/errors.js'
import { restoreSkipped } from '../../shared/metrics.js'
import type { FsBackend } from '../../store/backend.js'
import { addUserBody, mergeBody, userId } from '../validation.js'

export function usersRouter(backend: FsBackend): Router {
  const router = Router()

  router.get(
    '/',
    asyncHandler(async (_req, res) => {
      res.json({ users: await backend.listUsers() })
    }),
  )

  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const { id, capacity } = addUserBody.parse(req.body)
      await backend.addUser(id, capacity)
      res.status(201).json({ id, capacity })
    }),
  )

  router.post(
    '/:id/merge',
    asyncHandler(async (req, res) => {
      const targetId = userId.parse(req.params.id)
      const { sourceId } = mergeBody.parse(req.body)
      res.json({ targetId, sourceId, ...(await backend.mergeUsers(targetId, sourceId)) })
    }),
  )

  router.post(
    '/:id/backup',
    asyncHandler(async (req, res) => {
      const id = userId.parse(req.params.id)
      res.json({ id, ...(await backend.backupUser(id)) })
    }),
  )

  router.post(
    '/:id/restore',
    asyncHandler(async (req, res) => {
      const id = userId.parse(req.params.id)
      const result = await backend.restoreUser(id)
      restoreSkipped.inc(result.skipped.length)
      res.json({ id, ...result })
    }),
  )

  return router
}
