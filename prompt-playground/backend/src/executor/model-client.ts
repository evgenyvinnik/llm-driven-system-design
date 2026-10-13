/**
 * Streaming client for the model service, wrapped in a circuit breaker.
 *
 * Opening the stream is the only step that is retried or counted by the
 * breaker. Once tokens are flowing, a failure is reported as-is: the user has
 * already seen part of an answer, and silently starting over would show a
 * different one and bill twice.
 */
import CircuitBreaker from 'opossum'
import { config } from '../shared/config.js'
import { logger } from '../shared/logger.js'
import { SseParser } from '../shared/sse.js'

export interface GenerateBody {
  model: string
  system: string
  input: string
  temperature: number
  topP: number
  maxTokens: number
}

export type ModelEvent =
  | { type: 'token'; text: string }
  | { type: 'done'; finishReason: string; usage: { inputTokens: number; outputTokens: number } }
  | { type: 'error'; code: string; message: string }

/** Overload or connectivity problem before any output: safe to retry. */
export class RetryableModelError extends Error {
  constructor(
    message: string,
    public retryAfterMs = 0,
  ) {
    super(message)
  }
}

/** The model rejected the request itself; retrying would fail the same way. */
export class ModelRequestError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message)
  }
}

async function openStream(body: GenerateBody, signal: AbortSignal): Promise<Response> {
  let response: Response
  try {
    response = await fetch(`${config.modelBaseUrl}/v1/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal,
    })
  } catch (err) {
    if (signal.aborted) throw err
    throw new RetryableModelError(`model service unreachable: ${(err as Error).message}`)
  }
  if (response.status === 429 || response.status >= 500) {
    const retryAfter = Number(response.headers.get('Retry-After')) || 0
    await response.body?.cancel()
    throw new RetryableModelError(`model service returned ${response.status}`, retryAfter * 1000)
  }
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => '')
    throw new ModelRequestError('MODEL_REJECTED', `model service returned ${response.status}: ${text.slice(0, 200)}`)
  }
  return response
}

export const modelBreaker = new CircuitBreaker(openStream, {
  timeout: 10_000,
  errorThresholdPercentage: 50,
  volumeThreshold: 5,
  resetTimeout: 10_000,
  // Rejections and aborts are not signs of an unhealthy model service.
  errorFilter: (err: unknown) => err instanceof ModelRequestError || (err as Error)?.name === 'AbortError',
})
modelBreaker.on('open', () => logger.warn('model circuit opened'))
modelBreaker.on('halfOpen', () => logger.info('model circuit half-open'))
modelBreaker.on('close', () => logger.info('model circuit closed'))

export async function* streamModel(body: GenerateBody, signal: AbortSignal): AsyncGenerator<ModelEvent> {
  let response: Response
  try {
    response = (await modelBreaker.fire(body, signal)) as Response
  } catch (err) {
    if (modelBreaker.opened && !(err instanceof RetryableModelError) && !(err instanceof ModelRequestError)) {
      throw new RetryableModelError('model circuit is open')
    }
    throw err
  }

  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  const parser = new SseParser()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      for (const message of parser.push(decoder.decode(value, { stream: true }))) {
        const data = JSON.parse(message.data)
        if (message.event === 'token') yield { type: 'token', text: data.text }
        else if (message.event === 'done') {
          yield { type: 'done', finishReason: data.finishReason, usage: data.usage }
          return
        } else if (message.event === 'error') {
          yield { type: 'error', code: data.code ?? 'MODEL_ERROR', message: data.message ?? 'Model error' }
          return
        }
      }
    }
    yield { type: 'error', code: 'STREAM_ENDED', message: 'The model stream ended without finishing' }
  } finally {
    reader.releaseLock()
    // Closing the body tells the model service the caller went away.
    await response.body?.cancel().catch(() => undefined)
  }
}
