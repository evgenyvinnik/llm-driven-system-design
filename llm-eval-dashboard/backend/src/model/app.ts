/**
 * Mock model service. Streams planned tokens over SSE with a configurable time
 * to first token and tokens per second, a concurrency cap (529 when full), and
 * chaos switches: 429 with Retry-After, 529 overload, a hang (the caller's
 * timeout fires), a mid-stream disconnect, and a 400. It stops generating the
 * moment the caller disconnects, so a cancelled run really stops model work,
 * and it counts calls per eval run so tests can prove "zero calls".
 *
 *   POST /v1/generate               SSE: start, token…, done | error
 *   GET  /admin/state               settings, chaos, call stats
 *   PUT  /admin/settings            latency, capacity, Retry-After
 *   PUT  /admin/chaos               { armed: {kind: n}, rates: {kind: p} }
 *   POST /admin/chaos/reset, GET /admin/stats?runId=, POST /admin/stats/reset
 * @module model/app
 */
import express, { type Request, type Response } from 'express'
import { z } from 'zod'
import { CallStats, Chaos, CHAOS_KINDS } from '../shared/chaos.js'
import { httpMetrics, metricsHandler } from '../shared/metrics.js'
import { MODELS } from './catalog.js'
import { planGeneration } from './generator.js'

const generateSchema = z.object({
  model: z.string().min(1),
  system: z.string().max(100_000).default(''),
  prompt: z.string().max(100_000),
  temperature: z.number().min(0).max(2).default(0.7),
  maxTokens: z.number().int().min(1).max(4096).default(256),
  seed: z.number().int().default(0),
})

export interface ModelSettings {
  /** null: use each model's own latency. */
  ttftMs: number | null
  tokensPerSecond: number | null
  latencyMultiplier: number
  maxConcurrent: number
  retryAfterSeconds: number
}

const settingsSchema = z
  .object({
    ttftMs: z.number().int().min(0).max(60_000).nullable(),
    tokensPerSecond: z.number().min(1).max(5000).nullable(),
    latencyMultiplier: z.number().min(0).max(50),
    maxConcurrent: z.number().int().min(1).max(1000),
    retryAfterSeconds: z.number().min(0).max(120),
  })
  .partial()

const countsSchema = z.record(z.enum(CHAOS_KINDS), z.number().min(0).max(1000))
const chaosSchema = z.object({ armed: countsSchema.optional(), rates: countsSchema.optional() })

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const jitter = (ms: number) => ms * (0.85 + Math.random() * 0.3)

function sse(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

export function createModelApp(initial: Partial<ModelSettings> = {}) {
  const settings: ModelSettings = { ttftMs: null, tokensPerSecond: null, latencyMultiplier: 1, maxConcurrent: 64, retryAfterSeconds: 1, ...initial }
  const chaos = new Chaos()
  const stats = new CallStats()

  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: '2mb' }))
  app.use(httpMetrics)

  const state = () => ({ settings, chaos: chaos.snapshot(), stats: stats.snapshot(), models: Object.values(MODELS) })
  app.get('/health', (_req, res) => res.json({ status: 'ok', active: stats.active }))
  app.get('/metrics', metricsHandler)
  app.get('/admin/state', (_req, res) => res.json(state()))
  app.put('/admin/settings', (req, res) => {
    const parsed = settingsSchema.safeParse(req.body)
    if (!parsed.success) return void res.status(400).json({ error: { type: 'invalid_request_error', message: parsed.error.message } })
    Object.assign(settings, parsed.data)
    res.json(state())
  })
  app.put('/admin/chaos', (req, res) => {
    const parsed = chaosSchema.safeParse(req.body)
    if (!parsed.success) return void res.status(400).json({ error: { type: 'invalid_request_error', message: parsed.error.message } })
    if (parsed.data.armed) chaos.arm(parsed.data.armed)
    if (parsed.data.rates) chaos.setRates(parsed.data.rates)
    res.json(state())
  })
  app.post('/admin/chaos/reset', (_req, res) => {
    chaos.reset()
    res.json(state())
  })
  app.get('/admin/stats', (req, res) => res.json(stats.snapshot(typeof req.query.runId === 'string' ? req.query.runId : undefined)))
  app.post('/admin/stats/reset', (_req, res) => {
    stats.reset()
    res.json(stats.snapshot())
  })

  app.post('/v1/generate', async (req: Request, res: Response) => {
    const runId = req.get('x-eval-run-id') || undefined
    const finish = stats.start(runId)
    let aborted = false
    res.on('close', () => {
      if (!res.writableEnded) aborted = true
      finish()
    })
    const fail = (status: number, type: string, message: string, outcome: string) => {
      stats.outcome(outcome)
      res.status(status).json({ error: { type, message } })
    }

    const parsed = generateSchema.safeParse(req.body)
    if (!parsed.success) return fail(400, 'invalid_request_error', parsed.error.message, 'invalid')
    const body = parsed.data
    const spec = MODELS[body.model]

    const injected = chaos.next()
    if (injected === 'rate_limit') {
      res.setHeader('Retry-After', String(settings.retryAfterSeconds))
      return fail(429, 'rate_limit_error', 'Simulated rate limit', 'rate_limited')
    }
    if (injected === 'overloaded') return fail(529, 'overloaded_error', 'Simulated overload', 'overloaded')
    if (injected === 'invalid') return fail(400, 'invalid_request_error', 'Simulated invalid request', 'invalid')
    if (stats.active > settings.maxConcurrent) return fail(529, 'overloaded_error', 'All generation slots are busy', 'overloaded')
    if (injected === 'timeout') {
      // Hang without a byte: the caller's deadline is what ends this.
      stats.outcome('timeout')
      for (let waited = 0; waited < 120_000 && !aborted; waited += 100) await sleep(100)
      if (!res.writableEnded) res.destroy()
      return
    }

    const plan = planGeneration(body)
    if (!plan.ok) return fail(400, plan.errorType, plan.message, plan.errorType)

    const mult = settings.latencyMultiplier
    const ttft = (settings.ttftMs ?? spec.ttftMs) * mult
    const perToken = (1000 / (settings.tokensPerSecond ?? spec.tokensPerSecond)) * mult
    res.status(200)
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.flushHeaders()
    sse(res, 'start', { model: body.model, inputTokens: plan.inputTokens })
    await sleep(jitter(ttft))
    const cutAt = injected === 'disconnect' ? Math.max(1, Math.floor(plan.tokens.length / 2)) : -1
    for (let i = 0; i < plan.tokens.length; i++) {
      if (aborted) break
      if (i === cutAt) {
        stats.outcome('disconnected')
        res.destroy()
        return
      }
      sse(res, 'token', { text: plan.tokens[i] })
      if (perToken > 0) await sleep(jitter(perToken))
    }
    if (aborted) {
      stats.outcome('aborted_by_client')
      return
    }
    stats.outcome('completed')
    sse(res, 'done', { finishReason: plan.finishReason, usage: { inputTokens: plan.inputTokens, outputTokens: plan.outputTokens } })
    res.end()
  })

  return { app, settings, chaos, stats }
}
