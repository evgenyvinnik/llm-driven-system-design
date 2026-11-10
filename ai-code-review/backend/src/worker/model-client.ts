/**
 * Reads the model's SSE stream with fetch and a ReadableStream. It measures
 * time to first token and generation time, enforces a whole-call deadline,
 * and classifies failures. Retrying transport errors is the caller's choice.
 * @module worker/model-client
 */
import { config } from '../shared/config.js'
import { ModelCallError, type ModelCaller, type ModelResult, type ToolCall } from '../shared/model-types.js'

interface BlockState {
  type: string
  id?: string
  name?: string
  json: string
  text: string
}

export function createHttpCaller(baseUrl = config.modelUrl, timeoutMs = config.worker.modelTimeoutMs): ModelCaller {
  return async (request, opts) => {
    const started = Date.now()
    const deadline = AbortSignal.timeout(timeoutMs)
    const signal = opts.signal ? AbortSignal.any([opts.signal, deadline]) : deadline
    const classify = (err: unknown): ModelCallError => {
      if (err instanceof ModelCallError) return err
      if (opts.signal?.aborted) return new ModelCallError('aborted', 'The review was cancelled')
      if (deadline.aborted) return new ModelCallError('timeout', `No complete response within ${timeoutMs} ms`)
      return new ModelCallError('disconnect', `The stream broke: ${(err as Error).message}`)
    }

    try {
      const res = await fetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.modelApiKey ? { 'x-api-key': config.modelApiKey, 'anthropic-version': '2023-06-01' } : {}),
          ...(opts.runId ? { 'X-Review-Run-Id': opts.runId } : {}),
        },
        body: JSON.stringify({ ...request, stream: true }),
        signal,
      })
      if (res.status === 529 || res.status === 503) throw new ModelCallError('overloaded', `Model overloaded (${res.status})`)
      if (res.status === 429) throw new ModelCallError('rate_limited', 'Rate limited (429)', Number(res.headers.get('retry-after') ?? 1) * 1000)
      if (!res.ok || !res.body) throw new ModelCallError('http_error', `Model returned ${res.status}`)

      const result: ModelResult = { model: request.model, text: '', toolCalls: [], stopReason: 'unknown', inputTokens: 0, outputTokens: 0, ttftMs: 0, generationMs: 0 }
      const blocks = new Map<number, BlockState>()
      let firstTokenAt: number | null = null
      let finished = false
      const decoder = new TextDecoder()
      let buffer = ''

      const onEvent = (data: string) => {
        let e: Record<string, unknown>
        try {
          e = JSON.parse(data) as Record<string, unknown>
        } catch {
          throw new ModelCallError('protocol', 'Unreadable event in the stream')
        }
        if (e.type === 'message_start') {
          const message = e.message as { model?: string; usage?: { input_tokens?: number } }
          result.model = message.model ?? request.model
          result.inputTokens = message.usage?.input_tokens ?? 0
        } else if (e.type === 'content_block_start') {
          firstTokenAt ??= Date.now()
          const b = e.content_block as { type: string; id?: string; name?: string }
          blocks.set(e.index as number, { type: b.type, id: b.id, name: b.name, json: '', text: '' })
        } else if (e.type === 'content_block_delta') {
          const block = blocks.get(e.index as number)
          const delta = e.delta as { type: string; text?: string; partial_json?: string }
          if (block && delta.type === 'text_delta') block.text += delta.text ?? ''
          if (block && delta.type === 'input_json_delta') block.json += delta.partial_json ?? ''
        } else if (e.type === 'message_delta') {
          const delta = e.delta as { stop_reason?: string }
          const usage = e.usage as { output_tokens?: number } | undefined
          result.stopReason = delta.stop_reason ?? result.stopReason
          result.outputTokens = usage?.output_tokens ?? result.outputTokens
        } else if (e.type === 'message_stop') {
          finished = true
        } else if (e.type === 'error') {
          throw new ModelCallError('overloaded', 'The stream reported an error')
        }
      }

      const reader = res.body.getReader()
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let idx: number
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const raw = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          const dataLine = raw.split('\n').find((l) => l.startsWith('data: '))
          if (dataLine) onEvent(dataLine.slice(6))
        }
      }
      if (!finished) throw new ModelCallError('disconnect', 'The stream ended before the message finished')

      const toolCalls: ToolCall[] = []
      for (const b of [...blocks.entries()].sort(([a], [z]) => a - z).map(([, v]) => v)) {
        if (b.type === 'text') result.text += b.text
        if (b.type === 'tool_use') {
          let input: unknown = null
          try {
            input = b.json ? JSON.parse(b.json) : {}
          } catch {
            input = { unparsable: b.json.slice(0, 200) }
          }
          toolCalls.push({ id: b.id ?? 'unknown', name: b.name ?? 'unknown', input })
        }
      }
      result.toolCalls = toolCalls
      const first = firstTokenAt ?? Date.now()
      result.ttftMs = first - started
      result.generationMs = Date.now() - first
      return result
    } catch (err) {
      throw classify(err)
    }
  }
}

/** Transport failures say nothing about the change, so these may retry. Bad output is never retried. */
export function withTransportRetries(caller: ModelCaller, attempts = config.worker.modelAttempts, baseMs = config.worker.retryBaseMs): ModelCaller {
  return async (request, opts) => {
    let last: ModelCallError | null = null
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await caller(request, opts)
      } catch (err) {
        last = err as ModelCallError
        const retryable = last.code === 'overloaded' || last.code === 'rate_limited' || last.code === 'disconnect'
        if (!retryable || attempt === attempts) throw last
        const wait = Math.min(last.retryAfterMs ?? Math.random() * baseMs * 2 ** attempt, 2000)
        await new Promise((r) => setTimeout(r, wait))
        if (opts.signal?.aborted) throw new ModelCallError('aborted', 'The review was cancelled')
      }
    }
    throw last ?? new ModelCallError('protocol', 'No attempts were made')
  }
}
