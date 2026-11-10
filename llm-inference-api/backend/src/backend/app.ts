/**
 * Mock model backend HTTP surface.
 *
 *   POST /v1/batch      admit a group; NDJSON stream of events for its items
 *   POST /v1/cancel     stop sequences and free their slots
 *   GET  /health        status, version, slots, cache hit rate, chaos counts
 *   GET/PUT /admin/settings, POST /admin/drain, POST /admin/upgrade
 *
 * The backend is the authority on its own admission: a dispatcher with a stale
 * view gets a cheap 503/529 or a per-item `no_slot` and re-routes.
 * @module backend/app
 */
import express, { type Request, type Response } from 'express'
import { z } from 'zod'
import { errorBody } from '../shared/errors.js'
import { httpMetrics, metricsHandler } from '../shared/metrics.js'
import { CHAOS_KINDS, Engine, Refusal, type EngineEvent, type GroupSink } from './engine.js'

const itemSchema = z.object({
  id: z.string().min(1),
  prefixKey: z.string(),
  prefixTokens: z.number().int().min(0),
  inputTokens: z.number().int().min(1),
  maxTokens: z.number().int().min(1),
  seed: z.string(),
  outputTokens: z.number().int().min(1).optional(),
})

const batchSchema = z.object({ batchId: z.string().min(1), items: z.array(itemSchema).min(1).max(1000) })

const settingsSchema = z
  .object({
    ttftMs: z.number().int().min(0).max(20_000),
    prefillMsPerToken: z.number().min(0).max(10),
    tokensPerSecond: z.number().int().min(1).max(2000),
    admitOverheadMs: z.number().int().min(0).max(5000),
    crashAfterTokens: z.number().int().min(1).max(10_000),
    slots: z.number().int().min(1).max(1000),
    batching: z.enum(['continuous', 'static']),
    chaos: z.record(z.enum(CHAOS_KINDS), z.number().int().min(0).max(50)),
  })
  .partial()

export function createBackendApp(engine: Engine, id: string) {
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: '2mb' }))
  app.use(httpMetrics)

  const view = () => ({ id, ...engine.snapshot() })

  app.get('/health', (_req, res) => res.json(view()))
  app.get('/metrics', metricsHandler)
  app.get('/admin/settings', (_req, res) => res.json(view()))

  app.put('/admin/settings', (req, res) => {
    const parsed = settingsSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json(errorBody('invalid_request_error', parsed.error.message))
      return
    }
    const { chaos, ...rest } = parsed.data
    Object.assign(engine.settings, rest)
    if (chaos) Object.assign(engine.chaos, chaos)
    res.json(view())
  })

  app.post('/admin/drain', (req, res) => {
    engine.setDraining(Boolean(req.body?.draining))
    res.json(view())
  })

  app.post('/admin/upgrade', (req, res) => {
    const version = typeof req.body?.version === 'string' ? req.body.version.trim() : ''
    if (!version) {
      res.status(400).json(errorBody('invalid_request_error', 'version is required'))
      return
    }
    engine.upgrade(version)
    res.json(view())
  })

  app.post('/v1/cancel', (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? (req.body.ids as unknown[]).filter((x): x is string => typeof x === 'string') : []
    res.json({ cancelled: engine.cancel(ids) })
  })

  app.post('/v1/batch', (req: Request, res: Response) => {
    const parsed = batchSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json(errorBody('invalid_request_error', parsed.error.message))
      return
    }
    const { batchId, items } = parsed.data
    let open = true
    const sink: GroupSink = {
      write: (events: EngineEvent[]) => {
        if (open) res.write(events.map((e) => JSON.stringify(e)).join('\n') + '\n')
      },
      end: () => {
        if (!open) return
        open = false
        res.end()
      },
      destroy: () => {
        if (!open) return
        open = false
        res.destroy()
      },
    }
    let result: ReturnType<Engine['admit']>
    try {
      result = engine.admit(batchId, items, sink, Date.now())
    } catch (err) {
      if (err instanceof Refusal) {
        const type = err.status === 529 ? 'overloaded_error' : 'unavailable'
        res.status(err.status).json({ ...errorBody(type, err.reason), reason: err.reason })
        return
      }
      throw err
    }
    res.status(200)
    res.setHeader('Content-Type', 'application/x-ndjson')
    res.setHeader('Cache-Control', 'no-cache')
    res.flushHeaders()
    res.write(JSON.stringify({ t: 'admitted', ids: result.admitted, rejected: result.rejected, version: engine.settings.version, backend: id }) + '\n')
    if (result.admitted.length === 0) {
      open = false
      res.end()
      return
    }
    res.on('close', () => {
      if (open) {
        open = false
        engine.abandonGroup(batchId)
      }
    })
  })

  return app
}
