/**
 * Mock judge service: a separate process, like a real grader model behind its
 * own endpoint. Deterministic grades (judge/grader.ts), configurable latency,
 * the same chaos switches as the mock model, and a call counter.
 *
 *   POST /v1/judge     { rubric, strictness, passGrade, input, output, reference } → verdict
 *   GET  /admin/state, PUT /admin/settings, PUT /admin/chaos, POST /admin/chaos/reset,
 *   GET  /admin/stats?runId=, POST /admin/stats/reset
 * @module judge/app
 */
import express, { type Request, type Response } from 'express'
import { z } from 'zod'
import { CallStats, Chaos, CHAOS_KINDS } from '../shared/chaos.js'
import { httpMetrics, metricsHandler } from '../shared/metrics.js'
import { grade } from './grader.js'

const judgeSchema = z.object({
  rubric: z.string().max(4000),
  strictness: z.enum(['lenient', 'strict']).default('lenient'),
  passGrade: z.number().int().min(1).max(5).default(4),
  input: z.string().max(100_000).default(''),
  output: z.string().max(100_000),
  reference: z.string().max(100_000),
})

const settingsSchema = z.object({ latencyMs: z.number().int().min(0).max(60_000), retryAfterSeconds: z.number().min(0).max(120) }).partial()
const countsSchema = z.record(z.enum(CHAOS_KINDS), z.number().min(0).max(1000))
const chaosSchema = z.object({ armed: countsSchema.optional(), rates: countsSchema.optional() })
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export function createJudgeApp(initial: { latencyMs?: number; retryAfterSeconds?: number } = {}) {
  const settings = { latencyMs: 120, retryAfterSeconds: 1, ...initial }
  const chaos = new Chaos()
  const stats = new CallStats()
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: '2mb' }))
  app.use(httpMetrics)

  const state = () => ({ settings, chaos: chaos.snapshot(), stats: stats.snapshot() })
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

  app.post('/v1/judge', async (req: Request, res: Response) => {
    const finish = stats.start(req.get('x-eval-run-id') || undefined)
    let aborted = false
    res.on('close', () => {
      if (!res.writableEnded) aborted = true
      finish()
    })
    const parsed = judgeSchema.safeParse(req.body)
    if (!parsed.success) {
      stats.outcome('invalid')
      return void res.status(400).json({ error: { type: 'invalid_request_error', message: parsed.error.message } })
    }
    const injected = chaos.next()
    if (injected === 'rate_limit') {
      stats.outcome('rate_limited')
      res.setHeader('Retry-After', String(settings.retryAfterSeconds))
      return void res.status(429).json({ error: { type: 'rate_limit_error', message: 'Simulated rate limit' } })
    }
    if (injected === 'overloaded') {
      stats.outcome('overloaded')
      return void res.status(529).json({ error: { type: 'overloaded_error', message: 'Simulated overload' } })
    }
    if (injected === 'invalid') {
      stats.outcome('invalid')
      return void res.status(400).json({ error: { type: 'invalid_request_error', message: 'Simulated invalid request' } })
    }
    if (injected === 'timeout') {
      stats.outcome('timeout')
      for (let waited = 0; waited < 120_000 && !aborted; waited += 100) await sleep(100)
      if (!res.writableEnded) res.destroy()
      return
    }
    await sleep(settings.latencyMs * (0.85 + Math.random() * 0.3))
    if (aborted) return void stats.outcome('aborted_by_client')
    if (injected === 'disconnect') {
      stats.outcome('disconnected')
      return void res.destroy()
    }
    stats.outcome('completed')
    res.json(grade(parsed.data))
  })

  return { app, settings, chaos, stats }
}
