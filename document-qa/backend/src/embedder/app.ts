/**
 * Mock embedding service (separate process). A batch endpoint plus fault
 * knobs a real provider can't give on demand:
 * - `latencyMs` per batch,
 * - `failureRate` (random 500s),
 * - armed counts: the next N requests answer 429 (with Retry-After) or 500.
 * @module embedder/app
 */
import express, { type Request, type Response } from 'express'
import { z } from 'zod'
import { EMBEDDING_DIMS, EMBEDDING_MODEL, embed } from './embed.js'

export interface EmbedderSettings {
  latencyMs: number
  failureRate: number
  retryAfterSeconds: number
  armed: { rate_limited: number; server_error: number }
}

export function defaultEmbedderSettings(): EmbedderSettings {
  return {
    latencyMs: Number(process.env.EMBED_LATENCY_MS ?? 40),
    failureRate: Number(process.env.EMBED_FAILURE_RATE ?? 0),
    retryAfterSeconds: 1,
    armed: { rate_limited: 0, server_error: 0 },
  }
}

const patchSchema = z
  .object({
    latencyMs: z.number().int().min(0).max(30_000),
    failureRate: z.number().min(0).max(1),
    retryAfterSeconds: z.number().int().min(0).max(30),
    armed: z.object({ rate_limited: z.number().int().min(0).max(1000), server_error: z.number().int().min(0).max(1000) }).partial(),
  })
  .partial()

const embedSchema = z.object({ inputs: z.array(z.string().max(20_000)).min(1).max(256) })

export function createEmbedderApp(settings: EmbedderSettings = defaultEmbedderSettings()) {
  const stats = { requests: 0, inputs: 0, rateLimited: 0, failed: 0 }
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: '4mb' }))

  app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'mock-embedder', model: EMBEDDING_MODEL }))

  app.post('/v1/embeddings', async (req: Request, res: Response) => {
    stats.requests += 1
    const parsed = embedSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: { type: 'invalid_request', message: 'inputs must be 1-256 strings' } })
      return
    }
    if (settings.armed.rate_limited > 0) {
      settings.armed.rate_limited -= 1
      stats.rateLimited += 1
      res.setHeader('Retry-After', String(settings.retryAfterSeconds))
      res.status(429).json({ error: { type: 'rate_limited', message: 'Too many requests (armed fault)' } })
      return
    }
    if (settings.armed.server_error > 0 || Math.random() < settings.failureRate) {
      if (settings.armed.server_error > 0) settings.armed.server_error -= 1
      stats.failed += 1
      res.status(500).json({ error: { type: 'server_error', message: 'Embedding backend failed (injected fault)' } })
      return
    }
    if (settings.latencyMs > 0) await new Promise((r) => setTimeout(r, settings.latencyMs))
    stats.inputs += parsed.data.inputs.length
    res.json({ model: EMBEDDING_MODEL, dims: EMBEDDING_DIMS, vectors: parsed.data.inputs.map(embed) })
  })

  app.get('/_control/settings', (_req, res) => res.json({ settings, stats }))
  app.put('/_control/settings', (req, res) => {
    const parsed = patchSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(422).json({ error: { code: 'VALIDATION_FAILED', message: parsed.error.issues[0]?.message } })
      return
    }
    const { armed, ...rest } = parsed.data
    Object.assign(settings, rest)
    if (armed) Object.assign(settings.armed, armed)
    res.json({ settings, stats })
  })

  return app
}
