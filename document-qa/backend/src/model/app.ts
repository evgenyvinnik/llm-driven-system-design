/**
 * Mock model service (separate process), speaking a subset of the Anthropic
 * Messages API: `POST /v1/messages` with `stream: true` answers with
 * `message_start`, `content_block_delta` (text), `message_delta` (usage) and
 * `message_stop` SSE events.
 *
 * Knobs: time to first token, tokens per second, concurrent slots, a random
 * failure rate, and armed faults that fire on the next N requests:
 * `overloaded` (529 before the stream), `server_error` (500) and
 * `midstream_disconnect` (the socket is destroyed after a few tokens).
 * @module model/app
 */
import { randomBytes } from 'node:crypto'
import express, { type Request, type Response } from 'express'
import { z } from 'zod'
import { estimateTokens } from '../shared/text.js'
import { openSse, writeSse } from '../shared/sse.js'
import { composeAnswer, parsePrompt, streamTokens } from './answer.js'

export const MOCK_MODEL = 'mock-docqa-1'

export interface ModelSettings {
  ttftMs: number
  tokensPerSecond: number
  maxConcurrent: number
  failureRate: number
  disconnectAfterTokens: number
  armed: { overloaded: number; server_error: number; midstream_disconnect: number }
}

export function defaultModelSettings(): ModelSettings {
  return {
    ttftMs: Number(process.env.MOCK_TTFT_MS ?? 300),
    tokensPerSecond: Number(process.env.MOCK_TOKENS_PER_SECOND ?? 40),
    maxConcurrent: Number(process.env.MOCK_MAX_CONCURRENT ?? 8),
    failureRate: Number(process.env.MOCK_FAILURE_RATE ?? 0),
    disconnectAfterTokens: 6,
    armed: { overloaded: 0, server_error: 0, midstream_disconnect: 0 },
  }
}

const patchSchema = z
  .object({
    ttftMs: z.number().int().min(0).max(30_000),
    tokensPerSecond: z.number().int().min(1).max(5000),
    maxConcurrent: z.number().int().min(1).max(256),
    failureRate: z.number().min(0).max(1),
    disconnectAfterTokens: z.number().int().min(0).max(500),
    armed: z
      .object({
        overloaded: z.number().int().min(0).max(1000),
        server_error: z.number().int().min(0).max(1000),
        midstream_disconnect: z.number().int().min(0).max(1000),
      })
      .partial(),
  })
  .partial()

const messageSchema = z.object({
  model: z.string().optional(),
  max_tokens: z.number().int().min(1).max(8192).default(400),
  system: z.string().optional(),
  stream: z.boolean().optional(),
  messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() })).min(1),
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function apiError(res: Response, status: number, type: string, message: string): void {
  res.status(status).json({ type: 'error', error: { type, message } })
}

export function createModelApp(settings: ModelSettings = defaultModelSettings()) {
  let active = 0
  const stats = { requests: 0, completed: 0, overloaded: 0, failed: 0, disconnected: 0 }
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: '2mb' }))

  app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'mock-model', model: MOCK_MODEL, active }))

  app.post('/v1/messages', async (req: Request, res: Response) => {
    stats.requests += 1
    const parsed = messageSchema.safeParse(req.body)
    if (!parsed.success) return apiError(res, 400, 'invalid_request_error', parsed.error.issues[0]?.message ?? 'invalid request')
    if (settings.armed.overloaded > 0 || active >= settings.maxConcurrent) {
      if (settings.armed.overloaded > 0) settings.armed.overloaded -= 1
      stats.overloaded += 1
      return apiError(res, 529, 'overloaded_error', 'Overloaded')
    }
    if (settings.armed.server_error > 0 || Math.random() < settings.failureRate) {
      if (settings.armed.server_error > 0) settings.armed.server_error -= 1
      stats.failed += 1
      return apiError(res, 500, 'api_error', 'Internal server error (injected fault)')
    }
    const body = parsed.data
    const userContent = body.messages.filter((m) => m.role === 'user').at(-1)?.content ?? ''
    const answer = composeAnswer(parsePrompt(userContent))
    const inputTokens = estimateTokens((body.system ?? '') + body.messages.map((m) => m.content).join('\n'))
    let tokens = streamTokens(answer)
    let stopReason = 'end_turn'
    if (tokens.length > body.max_tokens) {
      tokens = tokens.slice(0, body.max_tokens)
      stopReason = 'max_tokens'
    }
    const disconnect = settings.armed.midstream_disconnect > 0
    if (disconnect) settings.armed.midstream_disconnect -= 1

    active += 1
    let closed = false
    res.on('close', () => {
      closed = true
    })
    try {
      const id = `msg_mock_${randomBytes(6).toString('hex')}`
      if (!body.stream) {
        await sleep(settings.ttftMs + (tokens.length * 1000) / settings.tokensPerSecond)
        res.json({
          id,
          type: 'message',
          role: 'assistant',
          model: MOCK_MODEL,
          content: [{ type: 'text', text: tokens.join('') }],
          stop_reason: stopReason,
          usage: { input_tokens: inputTokens, output_tokens: tokens.length },
        })
        stats.completed += 1
        return
      }
      openSse(res)
      writeSse(res, 'message_start', {
        type: 'message_start',
        message: { id, type: 'message', role: 'assistant', model: MOCK_MODEL, content: [], stop_reason: null, usage: { input_tokens: inputTokens, output_tokens: 0 } },
      })
      writeSse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      await sleep(settings.ttftMs)
      const gap = 1000 / settings.tokensPerSecond
      for (let i = 0; i < tokens.length; i++) {
        if (closed) return
        if (disconnect && i >= settings.disconnectAfterTokens) {
          stats.disconnected += 1
          res.socket?.destroy()
          return
        }
        writeSse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: tokens[i] } })
        if (i + 1 < tokens.length) await sleep(gap)
      }
      writeSse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 })
      writeSse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: tokens.length } })
      writeSse(res, 'message_stop', { type: 'message_stop' })
      res.end()
      stats.completed += 1
    } finally {
      active -= 1
    }
  })

  app.get('/_control/settings', (_req, res) => res.json({ settings, stats, active }))
  app.put('/_control/settings', (req, res) => {
    const parsed = patchSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(422).json({ error: { code: 'VALIDATION_FAILED', message: parsed.error.issues[0]?.message } })
      return
    }
    const { armed, ...rest } = parsed.data
    Object.assign(settings, rest)
    if (armed) Object.assign(settings.armed, armed)
    res.json({ settings, stats, active })
  })

  return app
}
