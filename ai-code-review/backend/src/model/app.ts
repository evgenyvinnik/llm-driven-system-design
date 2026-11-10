/**
 * The mock model over SSE, in Messages API format, with chaos switches. The
 * worker reads this stream with fetch and a ReadableStream, exactly as it would
 * read a real provider.
 * @module model/app
 */
import { randomBytes } from 'node:crypto'
import express, { type NextFunction, type Request, type Response } from 'express'
import { z } from 'zod'
import { logger } from '../shared/logger.js'
import { metricsHandler } from '../shared/metrics.js'
import { MODEL_VERSIONS } from '../shared/repos.js'
import type { ModelRequest } from '../shared/model-types.js'
import { assess } from './assess.js'
import { chaoticText, defaultSettings, nextChaos, settingsPatchSchema, type MockSettings } from './settings.js'

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted || ms <= 0) return resolve()
    const t = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(t)
      resolve()
    })
  })
}

function sse(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

const requestSchema = z.object({
  model: z.string(),
  system: z.string().default(''),
  messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.any() })).min(1),
  tools: z.array(z.any()).default([]),
  max_tokens: z.number().int().positive().default(2048),
})

export function createModelApp(settings: MockSettings = defaultSettings()) {
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: '25mb' }))
  const stats = { calls: 0, active: 0, outcomes: {} as Record<string, number> }
  const outcome = (k: string) => {
    stats.outcomes[k] = (stats.outcomes[k] ?? 0) + 1
  }

  app.get('/health', (_req, res) => res.json({ status: 'ok' }))
  app.get('/metrics', metricsHandler)
  app.get('/admin/settings', (_req, res) => res.json({ settings, stats }))
  app.patch('/admin/settings', (req, res) => {
    const patch = settingsPatchSchema.parse(req.body)
    const { chaos, ...rest } = patch
    Object.assign(settings, rest)
    if (chaos) Object.assign(settings.chaos, chaos)
    res.json({ settings, stats })
  })
  app.get('/v1/models', (_req, res) => res.json({ data: MODEL_VERSIONS.map((id) => ({ id })) }))

  app.post('/v1/messages', (req, res, next) => {
    void stream(req, res).catch(next)
  })

  async function stream(req: Request, res: Response): Promise<void> {
    const body = requestSchema.parse(req.body) as ModelRequest
    stats.calls++
    stats.active++
    const abort = new AbortController()
    res.on('close', () => {
      abort.abort()
    })
    try {
      const chaos = nextChaos(settings)
      if (chaos === 'overloaded' || settings.failureRate > Math.random() || stats.active > settings.maxConcurrent) {
        outcome('overloaded')
        res.status(529).json({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })
        return
      }
      if (chaos === 'rate_limited') {
        outcome('rate_limited')
        res.status(429).set('Retry-After', '1').json({ type: 'error', error: { type: 'rate_limit_error', message: 'Rate limited' } })
        return
      }

      res.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
      res.flushHeaders()

      if (chaos === 'timeout') {
        // Headers, then silence, until the caller gives up.
        outcome('timeout')
        await new Promise<void>((resolve) => abort.signal.addEventListener('abort', () => resolve()))
        return
      }

      const response = assess(body, { followInjections: settings.followInjections })
      const override = chaos ? chaoticText(chaos) : null
      const blocks = override ? [{ type: 'text' as const, text: override }] : response.blocks

      sse(res, 'message_start', { type: 'message_start', message: { id: `msg_${randomBytes(6).toString('hex')}`, model: body.model, usage: { input_tokens: response.inputTokens, output_tokens: 0 } } })
      await sleep(settings.ttftMs, abort.signal)

      for (let index = 0; index < blocks.length; index++) {
        const block = blocks[index]
        if (abort.signal.aborted) return
        if (block.type === 'text') {
          sse(res, 'content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
          const chunks = block.text.match(/[\s\S]{1,4}/g) ?? []
          const delay = 1000 / settings.tokensPerSecond
          for (let i = 0; i < chunks.length; i++) {
            if (abort.signal.aborted) return
            sse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: chunks[i] } })
            if (chaos === 'disconnect' && i === Math.floor(chunks.length / 2)) {
              outcome('disconnect')
              res.destroy()
              return
            }
            await sleep(delay, abort.signal)
          }
        } else if (block.type === 'tool_use') {
          sse(res, 'content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } })
          sse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } })
          if (chaos === 'disconnect') {
            outcome('disconnect')
            res.destroy()
            return
          }
        }
        sse(res, 'content_block_stop', { type: 'content_block_stop', index })
      }
      sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: override ? 'end_turn' : response.stopReason }, usage: { output_tokens: response.outputTokens } })
      sse(res, 'message_stop', { type: 'message_stop' })
      outcome(chaos ?? 'ok')
      res.end()
    } finally {
      stats.active--
    }
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof z.ZodError) {
      res.status(400).json({ type: 'error', error: { type: 'invalid_request_error', message: err.issues[0].message } })
      return
    }
    logger.error({ err }, 'mock model error')
    if (!res.headersSent) res.status(500).json({ type: 'error', error: { type: 'api_error', message: 'Internal error' } })
    else res.destroy()
  })
  return app
}
