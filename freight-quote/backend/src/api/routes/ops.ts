import { Router } from 'express'
import type { Redis } from 'ioredis'
import { z } from 'zod'
import { config } from '../../shared/config.js'
import { asyncHandler, HttpError } from '../../shared/errors.js'
import { requireRole } from '../../shared/auth.js'
import { getSettings, resetSettings, updateSettings } from '../../shared/settings.js'
import { loadSnapshots, mergeSnapshots, type OpsStats } from '../services/ops-stats.js'

async function depsFetch(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`${config.depsUrl}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(3_000),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new HttpError(res.status === 422 ? 422 : 502, 'DEPS_ERROR', `Mock dependency service: ${JSON.stringify(body)}`)
  return body
}

export function opsRouter(redis: Redis, stats: OpsStats): Router {
  const router = Router()
  router.use(requireRole('ops'))

  router.get(
    '/overview',
    asyncHandler(async (_req, res) => {
      await stats.publish(redis)
      const merged = mergeSnapshots(await loadSnapshots(redis))
      const settings = await getSettings(redis, 0)
      const [knobs, depStats] = await Promise.all([depsFetch('/knobs').catch(() => null), depsFetch('/stats').catch(() => null)])
      res.json({ ...merged, settings, knobs, depStats, at: new Date().toISOString() })
    }),
  )

  router.put(
    '/settings',
    asyncHandler(async (req, res) => {
      res.json({ settings: await updateSettings(redis, req.body) })
    }),
  )

  router.post(
    '/settings/reset',
    asyncHandler(async (_req, res) => {
      res.json({ settings: await resetSettings(redis) })
    }),
  )

  router.put(
    '/knobs/:dep',
    asyncHandler(async (req, res) => {
      const dep = z.enum(['pricing', 'fuel', 'capacity', 'availability']).parse(req.params.dep)
      res.json(await depsFetch(`/knobs/${dep}`, { method: 'PUT', body: JSON.stringify(req.body) }))
    }),
  )

  router.post(
    '/knobs/reset',
    asyncHandler(async (_req, res) => {
      res.json(await depsFetch('/knobs/reset', { method: 'POST' }))
    }),
  )

  router.post(
    '/stats/reset',
    asyncHandler(async (_req, res) => {
      stats.reset()
      await redis.publish('fq:ops:reset', '1')
      await depsFetch('/stats/reset', { method: 'POST' }).catch(() => undefined)
      res.json({ ok: true })
    }),
  )

  router.post(
    '/pricing/tariffs',
    requireRole('admin'),
    asyncHandler(async (req, res) => {
      const body = z.object({ origin: z.string(), destination: z.string(), commodity: z.string(), equipment: z.string(), version: z.number().int().positive().optional() }).parse(req.body)
      res.status(201).json(await depsFetch('/admin/tariffs/publish', { method: 'POST', body: JSON.stringify(body) }))
    }),
  )

  router.post(
    '/pricing/fuel',
    requireRole('admin'),
    asyncHandler(async (req, res) => {
      const body = z.object({ centsPerMile: z.number().positive().max(500), effectiveDate: z.string().optional() }).parse(req.body)
      res.status(201).json(await depsFetch('/admin/fuel/publish', { method: 'POST', body: JSON.stringify(body) }))
    }),
  )

  router.get(
    '/pricing/events',
    asyncHandler(async (_req, res) => {
      res.json(await depsFetch('/admin/events'))
    }),
  )

  router.post(
    '/pricing/events/:eventId/resend',
    requireRole('admin'),
    asyncHandler(async (req, res) => {
      res.json(await depsFetch(`/admin/events/${encodeURIComponent(req.params.eventId)}/resend`, { method: 'POST' }))
    }),
  )

  return router
}
