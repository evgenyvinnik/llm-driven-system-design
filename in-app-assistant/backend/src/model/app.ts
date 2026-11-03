/**
 * Mock model service. Serves POST /v1/messages in the Messages API wire
 * format (streaming SSE or a plain JSON response), so the orchestrator talks
 * to it with the official Anthropic SDK pointed at this base URL, exactly as
 * it would talk to Claude.
 *
 * Every request is stateless: the planner reads the conversation it is sent
 * and decides the next reply. Latency, concurrency slots, prompt caching and
 * failures (overload, rate limits, mid-stream disconnects, max_tokens cutoffs,
 * invented tool names, bad arguments, loops, refusals) are simulated.
 * @module model/app
 */
import { randomBytes } from 'node:crypto'
import express, { type Request, type Response } from 'express'
import client from 'prom-client'
import { childLogger } from '../shared/logger.js'
import { httpMetrics, metricsHandler, registry } from '../shared/metrics.js'
import { estimateTokens } from '../shared/tokens.js'
import { simulateCache } from './cache-sim.js'
import { readConversation, type RawRequest } from './conversation.js'
import { plan, type PlannedCall } from './planner.js'
import { CHAOS_KINDS, defaultSettings, settingsPatchSchema, type ChaosKind, type MockSettings } from './settings.js'

const log = childLogger('mock-model')

const requests = new client.Counter({
  name: 'mock_model_requests_total',
  help: 'Requests by model and outcome',
  labelNames: ['model', 'outcome'],
  registers: [registry],
})

export const PRIMARY_MODEL = 'mock-assistant'
const MODELS = new Set([PRIMARY_MODEL, 'mock-assistant-fallback'])

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const jitter = (ms: number) => ms * (0.8 + Math.random() * 0.4)
const id = (prefix: string) => `${prefix}_${randomBytes(12).toString('base64url')}`

const WRONG_NAMES: Record<string, string> = {
  search_mail: 'search_email',
  search_docs: 'search_documents',
  get_message: 'read_message',
  get_thread: 'read_thread',
  search_events: 'list_events',
  insert_text: 'add_text',
}

/** Splits text into token-sized pieces that keep their spacing. */
function textTokens(text: string): string[] {
  return text.match(/\s*\S{1,6}|\s+/g) ?? []
}

function errorBody(type: string, message: string) {
  return { type: 'error', error: { type, message } }
}

export function createModelApp(initial?: Partial<MockSettings>) {
  const settings: MockSettings = { ...defaultSettings(), ...initial }
  let active = 0

  /** Consumes one charge of an armed failure. */
  const fire = (kind: ChaosKind): boolean => {
    if (settings.chaos[kind] > 0) {
      settings.chaos[kind]--
      log.info({ kind, remaining: settings.chaos[kind] }, 'chaos fired')
      return true
    }
    return false
  }

  const app = express()
  app.use(express.json({ limit: '4mb' }))
  app.use(httpMetrics)
  app.get('/health', (_req, res) => res.json({ status: 'ok', active }))
  app.get('/metrics', metricsHandler)
  app.get('/admin/settings', (_req, res) => res.json({ settings, active, chaosKinds: CHAOS_KINDS }))
  app.put('/admin/settings', (req, res) => {
    const parsed = settingsPatchSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(422).json(errorBody('invalid_request_error', parsed.error.message))
      return
    }
    const { chaos, ...rest } = parsed.data
    Object.assign(settings, rest)
    if (chaos) Object.assign(settings.chaos, chaos)
    res.json({ settings, active, chaosKinds: CHAOS_KINDS })
  })

  app.post('/v1/messages', async (req: Request, res: Response) => {
    const body = req.body as RawRequest & { stream?: boolean }
    if (!body?.model || !Array.isArray(body.messages) || typeof body.max_tokens !== 'number') {
      res.status(400).json(errorBody('invalid_request_error', 'model, messages and max_tokens are required'))
      return
    }
    if (!MODELS.has(body.model)) {
      res.status(404).json(errorBody('not_found_error', `model: ${body.model}`))
      return
    }
    // Overload and rate limits hit only the primary model, as if one region were struggling,
    // so the orchestrator's fallback path has somewhere to go.
    if (body.model === PRIMARY_MODEL && fire('overloaded')) {
      requests.inc({ model: body.model, outcome: 'overloaded' })
      res.status(529).json(errorBody('overloaded_error', 'Overloaded'))
      return
    }
    if (body.model === PRIMARY_MODEL && fire('rate_limited')) {
      requests.inc({ model: body.model, outcome: 'rate_limited' })
      res.setHeader('retry-after', '1')
      res.status(429).json(errorBody('rate_limit_error', 'Rate limited'))
      return
    }
    if (active >= settings.maxConcurrent) {
      requests.inc({ model: body.model, outcome: 'busy' })
      res.status(529).json(errorBody('overloaded_error', 'All generation slots are busy'))
      return
    }

    active++
    let aborted = false
    res.on('close', () => {
      if (!res.writableEnded) aborted = true
    })
    try {
      const view = readConversation(body)
      const repeat = settings.chaos.repeat_call > 0 && view.steps.length > 0 && !view.wrapUp
      const planned = plan(view, { followInjectedInstructions: settings.followInjectedInstructions, repeatLastCall: repeat })
      if (repeat && planned.calls?.length) fire('repeat_call')
      let text = planned.text ?? ''
      const calls: PlannedCall[] = planned.calls ? structuredClone(planned.calls) : []
      if (view.continuation !== null && text.startsWith(view.continuation)) text = text.slice(view.continuation.length)

      if (calls.length && fire('invalid_tool_name')) calls[0].name = WRONG_NAMES[calls[0].name] ?? `${calls[0].name}_v2`
      else if (calls.length && fire('invalid_args')) corruptArgs(calls[0])

      const usage = simulateCache(body.model, body.tools, body.system, body.messages)
      const blocks: ({ type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> })[] = []
      if (text) blocks.push({ type: 'text', text })
      for (const c of calls) blocks.push({ type: 'tool_use', id: id('toolu'), name: c.name, input: c.input })

      let stopReason: string = calls.length ? 'tool_use' : 'end_turn'
      let truncateAt: { block: number; chars: number } | null = null
      const outputTokens = estimateTokens(text) + calls.reduce((n, c) => n + estimateTokens(c.input), 0)
      if (fire('refusal')) {
        blocks.length = 0
        stopReason = 'refusal'
      } else if (calls.length && fire('max_tokens_tool')) {
        truncateAt = { block: blocks.length - 1, chars: Math.floor(JSON.stringify(calls[calls.length - 1].input).length / 2) }
      } else if (!calls.length && text && fire('max_tokens_text')) {
        truncateAt = { block: 0, chars: Math.floor(text.length / 2) }
      } else if (outputTokens > body.max_tokens) {
        truncateAt = { block: 0, chars: body.max_tokens * 4 }
      }
      if (truncateAt) stopReason = 'max_tokens'
      const disconnect = fire('midstream_disconnect')

      const message = {
        id: id('msg'),
        type: 'message',
        role: 'assistant',
        model: body.model,
        stop_sequence: null,
      }
      if (!body.stream) {
        await sleep(jitter(settings.ttftMs))
        const content = truncateAt ? truncateBlocks(blocks, truncateAt) : blocks
        res.json({
          ...message,
          content,
          stop_reason: stopReason,
          stop_details: stopReason === 'refusal' ? { type: 'refusal', category: null, explanation: 'Simulated refusal' } : null,
          usage: { ...usage, output_tokens: Math.max(1, outputTokens) },
        })
        requests.inc({ model: body.model, outcome: stopReason })
        return
      }

      res.status(200)
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('request-id', id('req'))
      res.flushHeaders()
      const send = (event: string, data: Record<string, unknown>) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`)
      send('message_start', { message: { ...message, content: [], stop_reason: null, usage: { ...usage, output_tokens: 1 } } })
      await sleep(jitter(settings.ttftMs))

      const perToken = 1000 / settings.tokensPerSecond
      let emitted = 0
      const pieces = blocks.reduce((n, b) => n + (b.type === 'text' ? textTokens(b.text).length : Math.ceil(JSON.stringify(b.input).length / 24)), 0)
      const disconnectAfter = Math.max(1, Math.floor(pieces / 2))
      outer: for (const [index, block] of blocks.entries()) {
        if (aborted) break
        const limit = truncateAt && truncateAt.block === index ? truncateAt.chars : Infinity
        if (block.type === 'text') {
          send('content_block_start', { index, content_block: { type: 'text', text: '' } })
          let sent = 0
          for (const piece of textTokens(block.text)) {
            if (aborted) break outer
            if (sent >= limit) break
            const chunk = piece.slice(0, Math.max(0, limit - sent))
            sent += chunk.length
            send('content_block_delta', { index, delta: { type: 'text_delta', text: chunk } })
            if (disconnect && ++emitted >= disconnectAfter) {
              res.destroy()
              requests.inc({ model: body.model, outcome: 'disconnected' })
              return
            }
            await sleep(jitter(perToken))
          }
          send('content_block_stop', { index })
        } else {
          send('content_block_start', { index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } })
          const json = JSON.stringify(block.input)
          const end = Math.min(json.length, limit)
          for (let i = 0; i < end; i += 24) {
            if (aborted) break outer
            send('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: json.slice(i, Math.min(i + 24, end)) } })
            if (disconnect && ++emitted >= disconnectAfter) {
              res.destroy()
              requests.inc({ model: body.model, outcome: 'disconnected' })
              return
            }
            await sleep(5)
          }
          send('content_block_stop', { index })
        }
        if (truncateAt && truncateAt.block === index) break
      }
      if (aborted) {
        requests.inc({ model: body.model, outcome: 'aborted' })
        return
      }
      send('message_delta', {
        delta: {
          stop_reason: stopReason,
          stop_sequence: null,
          ...(stopReason === 'refusal' ? { stop_details: { type: 'refusal', category: null, explanation: 'Simulated refusal' } } : {}),
        },
        usage: { output_tokens: Math.max(1, outputTokens) },
      })
      send('message_stop', {})
      res.end()
      requests.inc({ model: body.model, outcome: stopReason })
    } catch (err) {
      log.error({ err }, 'mock model failed')
      if (!res.headersSent) res.status(500).json(errorBody('api_error', 'Internal mock model error'))
      else res.end()
    } finally {
      active--
    }
  })

  return app
}

function corruptArgs(c: PlannedCall): void {
  if ('after' in c.input || c.name === 'search_mail') c.input.after = 'last week'
  else if ('message_id' in c.input) c.input.message_id = 'the latest one'
  else if ('start_date' in c.input) c.input.start_date = 'tomorrow'
  else c.input.verbose = true
}

function truncateBlocks<T extends { type: string }>(blocks: T[], at: { block: number; chars: number }): T[] {
  return blocks.slice(0, at.block + 1).map((b, i) => {
    if (i !== at.block) return b
    if (b.type === 'text') return { ...b, text: (b as unknown as { text: string }).text.slice(0, at.chars) }
    return { ...b, input: {} }
  })
}
