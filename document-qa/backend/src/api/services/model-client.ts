/**
 * Streams a completion from the model in Messages API format. By default the
 * bundled mock model over plain HTTP + SSE; with ANTHROPIC_API_KEY set, the
 * real Claude API through the official SDK (optional, off by default, never
 * needed for setup, tests or screenshots). The real path asks for low effort
 * (this is grounded Q&A over a handful of sources) and opts into server-side
 * refusal fallbacks; a final `refusal` stop reason fails the run with its
 * category.
 *
 * A stream that ends without `message_stop` (socket destroyed, proxy cut) is
 * an interruption, not a completion: the caller fails the run and keeps the
 * partial text it already received.
 * @module api/services/model-client
 */
import Anthropic from '@anthropic-ai/sdk'
import { config } from '../../shared/config.js'
import { SseParser } from '../../shared/sse.js'

export class ModelError extends Error {
  constructor(
    message: string,
    public kind: 'overloaded' | 'http' | 'interrupted' | 'unreachable' | 'aborted',
    public status: number | null = null,
  ) {
    super(message)
  }
}

export interface ModelRequest {
  system: string
  user: string
  maxTokens: number
  signal: AbortSignal
  onDelta: (text: string) => void | Promise<void>
}

export interface ModelResult {
  text: string
  model: string
  inputTokens: number | null
  outputTokens: number | null
  stopReason: string | null
}

export const MOCK_MODEL_ID = 'mock-docqa-1'

let anthropic: Anthropic | null = null

/** The real provider, through the official SDK. Thinking stays on (it can't be disabled on this model); effort is low. */
async function streamAnthropic(req: ModelRequest): Promise<ModelResult> {
  anthropic ??= new Anthropic({ apiKey: config.anthropicApiKey })
  const result: ModelResult = { text: '', model: config.anthropicModel, inputTokens: null, outputTokens: null, stopReason: null }
  let message: Anthropic.Beta.BetaMessage
  try {
    const stream = anthropic.beta.messages.stream(
      {
        model: config.anthropicModel,
        max_tokens: 16_000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'low' },
        system: req.system,
        messages: [{ role: 'user', content: req.user }],
      },
      { signal: req.signal },
    )
    // Deltas are forwarded strictly in order (each one appends to the run's event stream).
    let forwarded: Promise<void> = Promise.resolve()
    stream.on('text', (delta) => {
      result.text += delta
      forwarded = forwarded.then(() => req.onDelta(delta))
    })
    message = await stream.finalMessage()
    await forwarded
  } catch (err) {
    if (req.signal.aborted || err instanceof Anthropic.APIUserAbortError) throw new ModelError('cancelled', 'aborted')
    if (err instanceof Anthropic.APIConnectionError) {
      throw new ModelError(`model ${result.text ? 'stream interrupted' : 'unreachable'}: ${err.message}`, result.text ? 'interrupted' : 'unreachable')
    }
    if (err instanceof Anthropic.APIError) {
      throw new ModelError(`model returned ${err.status ?? 'an error'}: ${err.message}`, err.status === 529 ? 'overloaded' : 'http', err.status ?? null)
    }
    throw new ModelError(`model stream interrupted: ${(err as Error).message}`, 'interrupted')
  }
  result.model = message.model
  result.inputTokens = message.usage.input_tokens
  result.outputTokens = message.usage.output_tokens
  result.stopReason = message.stop_reason
  if (message.stop_reason === 'refusal') {
    throw new ModelError(`model declined to answer (${message.stop_details?.category ?? 'refusal'})`, 'http')
  }
  return result
}

export async function streamModel(req: ModelRequest): Promise<ModelResult> {
  if (config.anthropicApiKey) return streamAnthropic(req)
  let res: Response
  try {
    res = await fetch(`${config.modelUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MOCK_MODEL_ID,
        max_tokens: req.maxTokens,
        system: req.system,
        stream: true,
        messages: [{ role: 'user', content: req.user }],
      }),
      signal: req.signal,
    })
  } catch (err) {
    if (req.signal.aborted) throw new ModelError('cancelled', 'aborted')
    throw new ModelError(`model unreachable: ${(err as Error).message}`, 'unreachable')
  }
  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => ({}))) as { error?: { type?: string; message?: string } }
    const kind = res.status === 529 || body.error?.type === 'overloaded_error' ? 'overloaded' : 'http'
    throw new ModelError(`model returned ${res.status}${body.error?.message ? `: ${body.error.message}` : ''}`, kind, res.status)
  }

  const result: ModelResult = { text: '', model: MOCK_MODEL_ID, inputTokens: null, outputTokens: null, stopReason: null }
  const parser = new SseParser()
  const decoder = new TextDecoder()
  const reader = res.body.getReader()
  let stopped = false
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      for (const msg of parser.push(decoder.decode(value, { stream: true }))) {
        const data = JSON.parse(msg.data) as Record<string, unknown>
        if (msg.event === 'message_start') {
          const m = data.message as { model?: string; usage?: { input_tokens?: number } }
          result.inputTokens = m.usage?.input_tokens ?? null
          if (m.model) result.model = m.model
        } else if (msg.event === 'content_block_delta') {
          const delta = data.delta as { type?: string; text?: string }
          if (delta.type === 'text_delta' && delta.text) {
            result.text += delta.text
            await req.onDelta(delta.text)
          }
        } else if (msg.event === 'message_delta') {
          const usage = data.usage as { output_tokens?: number } | undefined
          result.outputTokens = usage?.output_tokens ?? result.outputTokens
          result.stopReason = (data.delta as { stop_reason?: string }).stop_reason ?? null
        } else if (msg.event === 'message_stop') {
          stopped = true
        } else if (msg.event === 'error') {
          const e = data.error as { type?: string; message?: string } | undefined
          throw new ModelError(`model stream error: ${e?.message ?? 'unknown'}`, e?.type === 'overloaded_error' ? 'overloaded' : 'interrupted')
        }
      }
    }
  } catch (err) {
    if (err instanceof ModelError) throw err
    if (req.signal.aborted) throw new ModelError('cancelled', 'aborted')
    throw new ModelError(`model stream interrupted: ${(err as Error).message}`, 'interrupted')
  }
  if (req.signal.aborted) throw new ModelError('cancelled', 'aborted')
  if (!stopped) throw new ModelError('model stream ended before message_stop (connection dropped mid-answer)', 'interrupted')
  return result
}
