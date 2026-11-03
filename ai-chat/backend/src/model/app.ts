/**
 * Mock model service. Streams generated tokens over SSE with configurable time
 * to first token and speed, a concurrency limit (429 when full), injectable
 * mid-stream errors, and silent mid-stream disconnects. It stops generating as
 * soon as the caller disconnects, so a Stop in the UI really does stop
 * upstream work, and the admin page can watch `active` drop.
 */
import express, { type Request, type Response } from 'express'
import client from 'prom-client'
import { z } from 'zod'
import { estimateTokens, findModel, MODEL_IDS } from '../shared/catalog.js'
import { childLogger } from '../shared/logger.js'
import { httpMetrics, metricsHandler, registry } from '../shared/metrics.js'
import { DEFAULT_MODEL_SETTINGS, modelSettingsPatchSchema, type ModelSettings } from '../shared/model-settings.js'
import { openSse, writeSse } from '../shared/sse.js'
import { planGeneration } from './generator.js'

const log = childLogger('mock-model')

const generateSchema = z.object({
  model: z.enum(MODEL_IDS),
  messages: z
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(100_000) }))
    .min(1)
    .max(2000),
  maxTokens: z.number().int().min(1).max(4096).default(600),
  nonce: z.string().min(1).max(200),
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
  const settings: ModelSettings = { ...DEFAULT_MODEL_SETTINGS, ...initial }
  let active = 0

  const app = express()
  app.use(express.json({ limit: '4mb' }))
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

    const plan = planGeneration(body, spec, {
      failureRate: settings.failureRateOverride ?? spec.failureRate,
      disconnectRate: settings.disconnectRate,
    })
    const ttft = settings.ttftMsOverride ?? spec.ttftMs
    const perToken = 1000 / (settings.tokensPerSecondOverride ?? spec.tokensPerSecond)
    let outcome = 'completed'
    try {
      openSse(res)
      await sleep(jitter(ttft))
      for (let i = 0; i < plan.tokens.length; i++) {
        if (aborted) break
        writeSse(res, 'token', { text: plan.tokens[i] })
        if (plan.failAfterToken !== null && i === plan.failAfterToken) {
          writeSse(res, 'error', { code: 'MODEL_ERROR', message: 'The model failed partway through this answer' })
          outcome = 'failed'
          break
        }
        if (plan.disconnectAfterToken !== null && i === plan.disconnectAfterToken) {
          // No error event and no end: the caller sees the stream stop, as with a dropped connection.
          outcome = 'disconnected'
          res.socket?.destroy()
          break
        }
        await sleep(jitter(perToken))
      }
      if (aborted) {
        outcome = 'aborted'
        log.info({ model: body.model }, 'caller disconnected, generation stopped')
      } else if (outcome === 'completed') {
        writeSse(res, 'done', {
          finishReason: plan.finishReason,
          usage: {
            inputTokens: estimateTokens(body.messages.map((m) => m.content).join('\n')),
            outputTokens: plan.tokens.length,
          },
        })
      }
    } finally {
      active--
      activeGauge.set(active)
      generations.inc({ model: body.model, outcome })
      if (!res.destroyed) res.end()
    }
  })

  return app
}
