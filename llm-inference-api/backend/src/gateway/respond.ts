/**
 * The three response modes, and who owns the request in each:
 * - sync:   the connection owns it. The gateway waits for the terminal event
 *           and answers with one JSON message. Client disconnect or the sync
 *           deadline cancels the request (nobody is left to read the result).
 * - stream: the connection owns it, as with sync, but tokens are relayed as
 *           Messages-API SSE events as they arrive.
 * - async:  the request id owns it. 202 with the id; the work continues with
 *           no connection open; poll GET /v1/requests/:id or attach to
 *           GET /v1/requests/:id/events (resumable with Last-Event-ID).
 * `inference_status` is an extension event (queue time, backend, re-routes);
 * Messages-API clients that don't know it ignore it.
 * @module gateway/respond
 */
import type { Request, Response } from 'express'
import { keys, redis } from '../shared/cache.js'
import { pool } from '../shared/db.js'
import { errorBody } from '../shared/errors.js'
import { config } from '../shared/config.js'
import { getUsage, toPublicRequest, TERMINAL_EVENTS, type RequestRow } from '../shared/requests.js'
import { isTerminal } from '../shared/state-machine.js'
import { cancelRequest } from './cancel.js'
import { hub, type HubEvent } from './stream-hub.js'

export function statusForError(type: string): number {
  switch (type) {
    case 'overloaded_error':
      return 529
    case 'timeout_error':
      return 504
    case 'rate_limit_error':
      return 429
    case 'invalid_request_error':
      return 400
    default:
      return 500
  }
}

function setRequestHeaders(res: Response, row: RequestRow): void {
  res.setHeader('request-id', row.id)
  res.setHeader('x-priority-class', row.priority_class)
}

function messageJson(row: RequestRow, text: string, done: Record<string, unknown>) {
  return {
    id: row.id,
    type: 'message',
    role: 'assistant',
    model: row.model,
    content: [{ type: 'text', text }],
    stop_reason: done.stopReason ?? 'end_turn',
    stop_sequence: null,
    usage: done.usage ?? null,
  }
}

function latencyHeaders(res: Response, start: Record<string, unknown> | null, done: Record<string, unknown> | null): void {
  const latency = (done?.latency ?? {}) as Record<string, unknown>
  if (latency.queue_ms !== undefined) res.setHeader('x-inference-queue-ms', String(latency.queue_ms))
  if (latency.ttft_ms !== undefined) res.setHeader('x-inference-ttft-ms', String(latency.ttft_ms))
  if (start?.backendId) res.setHeader('x-inference-backend', String(start.backendId))
}

/** Answer for an Idempotency-Key replay of a sync or stream request. */
async function replay(res: Response, row: RequestRow): Promise<boolean> {
  setRequestHeaders(res, row)
  res.setHeader('idempotent-replayed', 'true')
  if (row.status === 'completed') {
    const usage = await getUsage(pool, row.id)
    res.json(toPublicRequest(row, usage).result)
    return true
  }
  res.status(409).json(errorBody('conflict_error', `A request with this Idempotency-Key is still in progress (${row.id}). Retry later, or poll it by id.`))
  return true
}

export async function respondSync(_req: Request, res: Response, row: RequestRow, replayed: boolean): Promise<void> {
  if (replayed && (await replay(res, row))) return
  setRequestHeaders(res, row)
  let start: Record<string, unknown> | null = null
  const text: string[] = []
  let finished = false
  let unsubscribe = () => {}
  const timer = setTimeout(() => {
    if (!finished) void cancelRequest(row.id, 'sync_timeout')
  }, Math.max(1000, row.deadline_at.getTime() - Date.now()))
  timer.unref?.()

  const finish = (ev: HubEvent) => {
    if (finished) return
    finished = true
    clearTimeout(timer)
    unsubscribe()
    if (res.writableEnded) return
    if (ev.type === 'done') {
      latencyHeaders(res, start, ev.data)
      res.json(messageJson(row, text.join(''), ev.data))
    } else if (ev.type === 'error') {
      const type = String(ev.data.type ?? 'api_error')
      res.status(statusForError(type)).json(errorBody(type, String(ev.data.message ?? 'Request failed')))
    } else {
      const reason = String(ev.data.reason ?? 'cancelled')
      if (reason === 'sync_timeout') res.status(504).json(errorBody('timeout_error', `Request ${row.id} did not finish within ${config.gateway.syncTimeoutMs} ms and was cancelled. Use async mode for long work.`))
      else res.status(409).json(errorBody('conflict_error', `Request ${row.id} was cancelled (${reason}).`))
    }
  }

  res.on('close', () => {
    if (!finished && !res.writableFinished) {
      finished = true
      clearTimeout(timer)
      unsubscribe()
      void cancelRequest(row.id, 'client_disconnected')
    }
  })
  unsubscribe = hub.subscribe(row.id, (ev) => {
    if (ev.type === 'start') start = ev.data
    else if (ev.type === 'delta') text.push(String(ev.data.text ?? ''))
    else if (TERMINAL_EVENTS.has(ev.type)) finish(ev)
  })
}

interface RelayOptions {
  /** Cancel the request if this connection closes first (connection-owned modes). */
  cancelOnClose: boolean
  /** Send SSE ids so the client can resume with Last-Event-ID. */
  withIds: boolean
  fromId: string
}

function openSse(res: Response, row: RequestRow): (event: string, data: Record<string, unknown>, id?: string) => void {
  res.status(200)
  setRequestHeaders(res, row)
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()
  return (event, data, id) => {
    if (res.writableEnded) return
    res.write(`${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`)
  }
}

function relay(_req: Request, res: Response, row: RequestRow, opts: RelayOptions): void {
  const send = openSse(res, row)
  let blockOpen = false
  let finished = false
  let unsubscribe = () => {}
  const end = () => {
    if (finished) return
    finished = true
    clearInterval(ping)
    unsubscribe()
    res.end()
  }
  if (opts.fromId === '0') {
    send('message_start', {
      message: { id: row.id, type: 'message', role: 'assistant', model: row.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: row.est_input_tokens, output_tokens: 0 } },
    })
    send('inference_status', { status: 'queued', priority: row.priority_class, mode: row.mode })
  }
  const ping = setInterval(() => send('ping', {}), config.gateway.pingMs)
  ping.unref?.()

  res.on('close', () => {
    if (!finished) {
      finished = true
      clearInterval(ping)
      unsubscribe()
      if (opts.cancelOnClose) void cancelRequest(row.id, 'client_disconnected')
    }
  })

  unsubscribe = hub.subscribe(
    row.id,
    (ev) => {
      const id = opts.withIds ? ev.eventId : undefined
      switch (ev.type) {
        case 'start':
          send('inference_status', { status: 'running', ...ev.data }, id)
          if (!blockOpen) {
            send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }, id)
            blockOpen = true
          }
          break
        case 'requeued':
          send('inference_status', { status: 'requeued', ...ev.data }, id)
          break
        case 'delta':
          if (!blockOpen) {
            send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }, id)
            blockOpen = true
          }
          send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: ev.data.text } }, id)
          break
        case 'done':
          if (blockOpen) send('content_block_stop', { index: 0 }, id)
          send('message_delta', { delta: { stop_reason: ev.data.stopReason, stop_sequence: null }, usage: ev.data.usage, latency: ev.data.latency }, id)
          send('message_stop', {}, id)
          end()
          break
        case 'cancelled':
          if (blockOpen) send('content_block_stop', { index: 0 }, id)
          send('message_delta', { delta: { stop_reason: 'cancelled', stop_sequence: null }, cancel_reason: ev.data.reason }, id)
          send('message_stop', {}, id)
          end()
          break
        case 'error':
          if (blockOpen) send('content_block_stop', { index: 0 }, id)
          send('error', { error: { type: ev.data.type ?? 'api_error', message: ev.data.message ?? 'Request failed' } }, id)
          end()
          break
      }
    },
    opts.fromId,
  )
}

export async function respondStream(req: Request, res: Response, row: RequestRow, replayed: boolean): Promise<void> {
  if (replayed && (await replay(res, row))) return
  relay(req, res, row, { cancelOnClose: true, withIds: false, fromId: '0' })
}

export function respondAsync(res: Response, row: RequestRow, replayed: boolean): void {
  setRequestHeaders(res, row)
  if (replayed) res.setHeader('idempotent-replayed', 'true')
  res.status(replayed ? 200 : 202).json({
    id: row.id,
    type: 'request',
    status: row.status,
    mode: row.mode,
    priority: row.priority_class,
    model: row.model,
    created_at: row.created_at.toISOString(),
    links: { self: `/v1/requests/${row.id}`, events: `/v1/requests/${row.id}/events`, cancel: `/v1/requests/${row.id}/cancel` },
  })
}

/**
 * Attach to any request's event log by id from any gateway instance. Leaving
 * never cancels. When the log has expired, the stored result is replayed.
 */
export async function respondAttach(req: Request, res: Response, row: RequestRow): Promise<void> {
  const lastEventId = req.get('last-event-id') || (typeof req.query.after === 'string' ? req.query.after : '') || '0'
  const exists = await redis.exists(keys.events(row.id))
  if (!exists && isTerminal(row.status)) {
    const send = openSse(res, row)
    send('message_start', { message: { id: row.id, type: 'message', role: 'assistant', model: row.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: row.est_input_tokens, output_tokens: 0 } } })
    if (row.output_text) {
      send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
      send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: row.output_text } })
      send('content_block_stop', { index: 0 })
    }
    if (row.status === 'failed') send('error', { error: { type: row.error_type, message: row.error_message } })
    else {
      send('message_delta', { delta: { stop_reason: row.status === 'cancelled' ? 'cancelled' : row.stop_reason, stop_sequence: null } })
      send('message_stop', {})
    }
    res.end()
    return
  }
  relay(req, res, row, { cancelOnClose: false, withIds: true, fromId: lastEventId })
}
