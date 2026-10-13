/**
 * Mock model service. Streams generated tokens over SSE with realistic latency,
 * a concurrency limit (429 when full), and injectable mid-stream failures.
 * It stops generating as soon as the caller disconnects, so a cancelled run
 * really does stop upstream work.
 */
import { randomUUID } from 'node:crypto'
import express, { type Request, type Response } from 'express'
import client from 'prom-client'
import { z } from 'zod'
import { estimateTokens, findModel, MODEL_IDS } from '../shared/catalog.js'
import { childLogger } from '../shared/logger.js'
import { modelSettingsPatchSchema, type ModelSettings } from '../shared/model-settings.js'
import { httpMetrics, metricsHandler, registry } from '../shared/metrics.js'
import { openSse, writeSse } from '../shared/sse.js'
import { planGeneration } from './generator.js'

const log = childLogger('mock-model')

const generateSchema = z.object({
  model: z.enum(MODEL_IDS),
  system: z.string().max(50_000).default(''),
  input: z.string().max(50_000),
  temperature: z.number().min(0).max(2).default(0.7),
  topP: z.number().min(0).max(1).default(1),
  maxTokens: z.number().int().min(1).max(4096).default(512),
  seed: z.number().int().optional(),
})

const generations = new client.Counter({
  name: 'mock_model_generations_total',
  help: 'Generations by outcome',
  labelNames: ['model', 'outcome'],
  registers: [registry],
})
const activeGauge = new client.Gauge({
  name: 'mock_model_active_generations',
  help: 'Generations streaming right now',
  registers: [registry],
})

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const jitter = (ms: number) => ms * (0.8 + Math.random() * 0.4)

export function createModelApp(initial?: Partial<ModelSettings>) {
  const settings: ModelSettings = {
    failureRateOverride: null,
    latencyMultiplier: 1,
    maxConcurrent: 16,
    ...initial,
  }
  let active = 0

  const app = express()
  app.use(express.json({ limit: '1mb' }))
  app.use(httpMetrics)

  app.get('/health', (_req, res) => res.json({ status: 'ok', active, settings }))
  app.get('/metrics', metricsHandler)
  app.get('/admin/settings', (_req, res) => res.json({ settings, active }))
  app.put('/admin/settings', (req, res) => {
    const parsed = modelSettingsPatchSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(422).json({ error: { code: 'VALIDATION_FAILED', message: parsed.error.message } })
      return
    }
    Object.assign(settings, parsed.data)
    log.info({ settings }, 'settings updated')
    res.json({ settings, active })
  })

  app.post('/v1/generate', async (req: Request, res: Response) => {
    const parsed = generateSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: { code: 'INVALID_REQUEST', message: parsed.error.message } })
      return
    }
    const body = parsed.data
    const spec = findModel(body.model)!
    if (active >= settings.maxConcurrent) {
      generations.inc({ model: body.model, outcome: 'overloaded' })
      res.setHeader('Retry-After', '1')
      res.status(429).json({ error: { code: 'OVERLOADED', message: 'All generation slots are busy' } })
      return
    }

    active++
    activeGauge.set(active)
    let aborted = false
    res.on('close', () => {
      if (!res.writableEnded) aborted = true
    })

    const failureRate = settings.failureRateOverride ?? spec.failureRate
    const plan = planGeneration(body, spec, randomUUID(), failureRate)
    const perToken = 1000 / spec.tokensPerSecond
    let outcome = 'completed'
    try {
      openSse(res)
      await sleep(jitter(spec.ttftMs * settings.latencyMultiplier))
      for (let i = 0; i < plan.tokens.length; i++) {
        if (aborted) break
        writeSse(res, 'token', { text: plan.tokens[i] })
        if (plan.failAfterToken !== null && i === plan.failAfterToken) {
          writeSse(res, 'error', { code: 'MODEL_ERROR', message: 'Simulated failure partway through generation' })
          outcome = 'failed'
          break
        }
        await sleep(jitter(perToken * settings.latencyMultiplier))
      }
      if (aborted) {
        outcome = 'aborted'
        log.info({ model: body.model }, 'caller disconnected, generation stopped')
      } else if (outcome === 'completed') {
        writeSse(res, 'done', {
          finishReason: plan.finishReason,
          usage: { inputTokens: estimateTokens(body.system + body.input), outputTokens: plan.tokens.length },
        })
      }
    } finally {
      active--
      activeGauge.set(active)
      generations.inc({ model: body.model, outcome })
      res.end()
    }
  })

  return app
}
