/**
 * HTTP surface of the simulated control plane, shaped like the Azure APIs the
 * remediation system calls (paths, verbs, headers and status codes), plus an
 * /admin API to inspect state and arm faults.
 * @module cloud-sim/app
 */
import express, { type Request, type Response } from 'express'
import { z } from 'zod'
import { errorHandler, asyncHandler } from '../shared/errors.js'
import { httpMetrics, metricsHandler } from '../shared/metrics.js'
import type { PolicyEffect } from '../domain/types.js'
import { Fleet, parseSimPath, type SimResponse } from './fleet.js'

function send(res: Response, r: SimResponse): void {
  if (r.headers) for (const [k, v] of Object.entries(r.headers)) res.setHeader(k, v)
  res.status(r.status).json(r.body)
}

const faultsSchema = z
  .object({
    writeCapacity: z.number().positive(),
    writeRefillPerSec: z.number().positive(),
    readCapacity: z.number().positive(),
    readRefillPerSec: z.number().positive(),
    graphCapacity: z.number().positive(),
    graphRefillPerSec: z.number().positive(),
    logQueryCapacity: z.number().positive(),
    logQueryRefillPerSec: z.number().positive(),
    graphLagMs: z.number().int().min(0),
    error5xxRate: z.number().min(0).max(1),
    ambiguous5xxShare: z.number().min(0).max(1),
    periodicJobsFireDuringBake: z.boolean(),
    periodicFireDelayMs: z.number().int().min(0),
  })
  .partial()

export interface SimHooks {
  reload: () => void
  reset: () => void
}

export function createSimApp(fleet: Fleet, hooks: SimHooks) {
  const app = express()
  app.disable('x-powered-by')
  app.use(httpMetrics)
  app.use(express.json({ limit: '1mb' }))

  app.get('/health', (_req, res) => res.json({ status: 'ok', accounts: fleet.state.accounts.length }))
  app.get('/metrics', metricsHandler)

  app.get('/subscriptions', (_req, res) => send(res, fleet.listSubscriptions()))

  app.post('/providers/Microsoft.ResourceGraph/resources', (req, res) => {
    const body = (req.body ?? {}) as { subscriptions?: string[]; options?: { $top?: number; $skipToken?: string } }
    const principal = req.header('x-sim-principal') ?? 'anonymous'
    send(res, fleet.graphQuery({ subscriptions: body.subscriptions, top: body.options?.$top, skipToken: body.options?.$skipToken }, principal))
  })

  app.get('/changes', (req, res) => {
    const since = Number.parseInt(String(req.query.since ?? '0'), 10) || 0
    const limit = Number.parseInt(String(req.query.limit ?? '500'), 10) || 500
    send(res, fleet.changesSince(since, limit))
  })

  app.post('/v1/workspaces/:workspace/query', (req, res) => {
    const body = (req.body ?? {}) as { resourceIds?: string[]; days?: number }
    send(res, fleet.queryLogs(body.resourceIds ?? [], Math.min(Math.max(body.days ?? 30, 1), 180), req.header('x-sim-principal') ?? 'anonymous'))
  })

  app.put('/providers/Microsoft.Authorization/policyAssignments/:name', (req, res) => {
    const body = (req.body ?? {}) as { properties?: { metadata?: { controlId?: string }; parameters?: { effect?: { value?: string } } } }
    const controlId = body.properties?.metadata?.controlId ?? req.params.name
    const effect = (body.properties?.parameters?.effect?.value ?? null) as PolicyEffect | null
    send(res, fleet.setPolicy(controlId, effect))
  })

  // ARM resource operations. One handler parses the path into (account, kind).
  const resource = (req: Request, res: Response) => {
    const path = req.path
    const parsed = parseSimPath(path)
    if (!parsed) return send(res, { status: 404, body: { error: { code: 'NotFound', message: 'Unknown path' } } })
    if (parsed.kind === 'metrics') {
      const [from, to] = String(req.query.timespan ?? '').split('/').map((t) => Date.parse(t))
      return send(res, fleet.metrics(path, Number.isFinite(from) ? from : Date.now() - 10 * 60_000, Number.isFinite(to) ? to : Date.now()))
    }
    if (req.method === 'GET') return send(res, fleet.getResource(path))
    const expectedVerb = parsed.kind === 'account' ? 'PATCH' : 'PUT'
    if (req.method !== expectedVerb) return send(res, { status: 405, body: { error: { code: 'MethodNotAllowed', message: `Use ${expectedVerb}` } } })
    return send(res, fleet.writeResource(path, req.body, req.header('if-match') ?? undefined, req.header('x-ms-client-request-id') ?? undefined))
  }
  app.get(/^\/subscriptions\/.+/, resource)
  app.patch(/^\/subscriptions\/.+/, resource)
  app.put(/^\/subscriptions\/.+/, resource)

  // Admin: inspection and fault injection for demos and tests.
  app.get('/admin/state', (_req, res) => res.json(fleet.summary()))
  app.put('/admin/faults', (req, res) => res.json({ faults: fleet.setFaults(faultsSchema.parse(req.body)) }))
  app.post('/admin/writes', (req, res) => res.json({ writes: fleet.writeCounts(z.object({ ids: z.array(z.string()).max(2000) }).parse(req.body).ids) }))
  app.post('/admin/drift', (req, res) => {
    const { count } = z.object({ count: z.number().int().min(1).max(100) }).parse(req.body)
    const results = Array.from({ length: count }, () => fleet.createFromTemplate())
    res.json({
      created: results.filter((r) => r.status === 'created').map((r) => ({ id: r.id, modifiedByPolicy: r.modified })),
      denied: results.filter((r) => r.status === 'denied').map((r) => r.reason),
    })
  })
  app.post('/admin/inject', (req, res) => {
    const body = z.object({ resourceId: z.string(), authType: z.enum(['AccountKey', 'SAS', 'Anonymous']).optional() }).parse(req.body)
    send(res, fleet.injectHiddenDependency(body.resourceId, body.authType))
  })
  // Activity-log lookup by client request ID: did this operation land?
  app.get('/admin/operations/:id', (req, res) => {
    const op = fleet.operation(req.params.id)
    if (!op) {
      res.status(404).json({ error: { code: 'NotFound', message: 'No operation with that client request ID' } })
      return
    }
    res.json({ operationId: req.params.id, ...op })
  })
  app.get('/admin/accounts/:name', (req, res) => {
    const a = fleet.state.accounts.find((x) => x.name === req.params.name)
    if (!a) {
      res.status(404).json({ error: { code: 'NotFound', message: 'No such account' } })
      return
    }
    res.json({ account: a })
  })
  app.post(
    '/admin/reload',
    asyncHandler(async (_req, res) => {
      hooks.reload()
      res.json(fleet.summary())
    }),
  )
  app.post('/admin/reset', (_req, res) => {
    hooks.reset()
    res.json(fleet.summary())
  })

  app.use(errorHandler)
  return app
}
