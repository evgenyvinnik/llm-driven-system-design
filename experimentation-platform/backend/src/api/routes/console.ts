/**
 * Console API: flags and experiments, per-environment configs, status and the
 * kill switch, version history, audit log, results, live SDK clients and
 * snapshot history. Reads need admin or viewer; every write needs admin.
 * @module api/routes/console
 */
import { Router, type Request } from 'express'
import { z } from 'zod'
import { requireAdmin, requireConsole } from '../../shared/auth.js'
import { keys, redis } from '../../shared/cache.js'
import { config } from '../../shared/config.js'
import { asyncHandler, HttpError } from '../../shared/errors.js'
import { createFlagSchema, killSchema, metadataSchema, statusSchema, updateConfigSchema } from '../../domain/flag-model.js'
import { listClients } from '../../services/client-registry.js'
import { environmentExists, listEnvironments } from '../../services/environment-service.js'
import {
  createFlag,
  getFlag,
  killSwitch,
  listAudit,
  listFlags,
  listVersions,
  transitionStatus,
  updateConfig,
  updateMetadata,
  type Actor,
} from '../../services/flag-service.js'
import { getResults } from '../../services/results-service.js'
import { getLatest, listSnapshots } from '../../services/snapshot-service.js'
import { streamCounts } from '../live.js'

export const consoleRouter = Router()
consoleRouter.use(requireConsole)

const actor = (req: Request): Actor => ({ id: req.user!.id, username: req.user!.username })

async function envParam(value: unknown): Promise<string> {
  const env = typeof value === 'string' ? value : 'prod'
  if (!(await environmentExists(env))) throw new HttpError(404, 'NOT_FOUND', `Unknown environment ${env}`)
  return env
}

/** If-Match: "3" (or a bare 3) is the config version the editor started from. */
function expectedVersion(req: Request): number | undefined {
  const raw = req.get('If-Match')
  if (!raw) return undefined
  const n = Number(raw.replace(/^W\//, '').replace(/"/g, ''))
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'BAD_IF_MATCH', 'If-Match must be a config version')
  return n
}

consoleRouter.get(
  '/environments',
  asyncHandler(async (req, res) => {
    const envs = await listEnvironments()
    res.json({
      environments: envs.map((e) => ({
        key: e.key,
        name: e.name,
        clientKey: e.clientKey,
        // The server key is a secret: only admins see it.
        serverKey: req.user!.role === 'admin' ? e.serverKey : null,
      })),
    })
  }),
)

consoleRouter.get(
  '/system',
  asyncHandler(async (_req, res) => {
    const envs = await listEnvironments()
    const counts = streamCounts()
    const environments = await Promise.all(
      envs.map(async (e) => ({ key: e.key, heldVersion: (await getLatest(e.key))?.version ?? 0, streamsOnThisInstance: counts[e.key] ?? 0 })),
    )
    const beat = await redis.get(keys.workerHeartbeat).catch(() => null)
    res.json({ instanceId: config.instanceId, environments, worker: beat ? JSON.parse(beat) : null })
  }),
)

consoleRouter.get(
  '/flags',
  asyncHandler(async (_req, res) => {
    res.json({ flags: await listFlags() })
  }),
)

consoleRouter.post(
  '/flags',
  requireAdmin,
  asyncHandler(async (req, res) => {
    res.status(201).json({ flag: await createFlag(actor(req), createFlagSchema.parse(req.body)) })
  }),
)

consoleRouter.get(
  '/flags/:key',
  asyncHandler(async (req, res) => {
    res.json({ flag: await getFlag(req.params.key) })
  }),
)

consoleRouter.patch(
  '/flags/:key',
  requireAdmin,
  asyncHandler(async (req, res) => {
    res.json({ flag: await updateMetadata(actor(req), req.params.key, metadataSchema.parse(req.body)) })
  }),
)

consoleRouter.put(
  '/flags/:key/environments/:env',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const env = await envParam(req.params.env)
    res.json(await updateConfig(actor(req), req.params.key, env, expectedVersion(req), updateConfigSchema.parse(req.body)))
  }),
)

consoleRouter.post(
  '/flags/:key/environments/:env/status',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const env = await envParam(req.params.env)
    const body = statusSchema.parse(req.body)
    res.json(await transitionStatus(actor(req), req.params.key, env, body.to, body.reason, expectedVersion(req)))
  }),
)

consoleRouter.post(
  '/flags/:key/environments/:env/kill',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const env = await envParam(req.params.env)
    res.json(await killSwitch(actor(req), req.params.key, env, killSchema.parse(req.body).reason))
  }),
)

consoleRouter.get(
  '/flags/:key/environments/:env/versions',
  asyncHandler(async (req, res) => {
    res.json({ versions: await listVersions(req.params.key, await envParam(req.params.env)) })
  }),
)

consoleRouter.get(
  '/flags/:key/results',
  asyncHandler(async (req, res) => {
    res.json(await getResults(req.params.key, await envParam(req.query.env)))
  }),
)

const auditQuery = z.object({ flag: z.string().max(64).optional(), env: z.string().max(32).optional(), limit: z.coerce.number().int().min(1).max(500).default(100) })

consoleRouter.get(
  '/audit',
  asyncHandler(async (req, res) => {
    const q = auditQuery.parse(req.query)
    res.json({ entries: await listAudit({ flagKey: q.flag, environment: q.env, limit: q.limit }) })
  }),
)

consoleRouter.get(
  '/clients',
  asyncHandler(async (req, res) => {
    const env = await envParam(req.query.env)
    const [clients, latest, snapshots] = await Promise.all([listClients(env), getLatest(env), listSnapshots(env, 8)])
    res.json({ environment: env, latestVersion: latest?.version ?? 0, clients, snapshots, servedBy: config.instanceId })
  }),
)
