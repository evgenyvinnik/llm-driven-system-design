/**
 * Namespace endpoints: list, largest, and file create/update/delete.
 * Paths travel in the query string or body, never as a route segment, because
 * they contain slashes.
 */
import { Router } from 'express'
import { asyncHandler } from '../../shared/errors.js'
import type { FsBackend } from '../../store/backend.js'
import { addFileBody, largestQuery, listQuery, pathQuery, updateFileBody } from '../validation.js'

export function fsRouter(backend: FsBackend): Router {
  const router = Router()

  router.get(
    '/list',
    asyncHandler(async (req, res) => {
      const { path } = listQuery.parse(req.query)
      res.json(await backend.listDir(path))
    }),
  )

  router.get(
    '/largest',
    asyncHandler(async (req, res) => {
      const { prefix, n } = largestQuery.parse(req.query)
      res.json({ prefix, files: await backend.largest(prefix, n) })
    }),
  )

  router.post(
    '/files',
    asyncHandler(async (req, res) => {
      const { path, size, owner } = addFileBody.parse(req.body)
      const { remaining } = await backend.addFile(path, size, owner)
      res.status(201).json({ path, size, owner, remaining })
    }),
  )

  router.patch(
    '/files',
    asyncHandler(async (req, res) => {
      const { path } = pathQuery.parse(req.query)
      const { size } = updateFileBody.parse(req.body)
      const { previous } = await backend.updateFile(path, size)
      res.json({ path, size, previous })
    }),
  )

  router.delete(
    '/files',
    asyncHandler(async (req, res) => {
      const { path } = pathQuery.parse(req.query)
      const { size } = await backend.deleteFile(path)
      res.json({ path, size })
    }),
  )

  return router
}
