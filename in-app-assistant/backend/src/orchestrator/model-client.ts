/**
 * call_model: one model call with streaming, retries and a fallback model.
 *
 * The same Anthropic SDK client talks to the mock model (base URL pointed at
 * it) or to Claude (ANTHROPIC_API_KEY set). Text deltas stream to the browser
 * as they arrive; tool-call arguments arrive in fragments and are only used
 * once the SDK has assembled the complete block.
 *
 * Rate limits, overloads, server errors and dropped connections are retried
 * with increasing delays, then the fallback model gets a try. A stream that
 * dies after some text reached the screen is redone from the start, and the
 * browser is told to throw the partial text away.
 * @module orchestrator/model-client
 */
import Anthropic from '@anthropic-ai/sdk'
import { config } from '../shared/config.js'
import { childLogger } from '../shared/logger.js'
import { modelCalls, modelTokens } from '../shared/metrics.js'

const log = childLogger('model-client')

export const anthropic = new Anthropic({
  apiKey: config.model.apiKey,
  baseURL: config.model.baseUrl,
  // Retries are ours, so each one is visible in the turn's audit trail.
  maxRetries: 0,
  timeout: 90_000,
})

const isReal = config.model.provider === 'anthropic'

/** User and assistant turns; this harness never sends mid-conversation system messages. */
export type MessageParam = Extract<Anthropic.Beta.Messages.BetaMessageParam, { role: 'user' } | { role: 'assistant' }>
export type MessageContent = Anthropic.Beta.Messages.BetaMessageContentParam
export type ContentBlock = Anthropic.Beta.Messages.BetaContentBlock
export type ToolUnion = Anthropic.Beta.Messages.BetaToolUnion
export type Message = Anthropic.Beta.Messages.BetaMessage

export interface ModelRequest {
  system: Anthropic.Beta.Messages.BetaTextBlockParam[]
  tools: ToolUnion[]
  messages: MessageParam[]
  maxTokens: number
  toolChoice?: 'auto' | 'none'
}

export interface ModelHooks {
  onText: (text: string) => void
  onDiscard: (reason: string) => void
  onRetry: (message: string) => void
}

export interface ModelReply {
  message: Message
  model: string
  attempts: number
  fallbackUsed: boolean
  latencyMs: number
}

export class CancelledError extends Error {
  constructor() {
    super('Turn cancelled')
  }
}

export class ModelUnavailableError extends Error {}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new CancelledError())
    })
  })

/** Client errors (bad request, auth, not found) won't get better on retry. */
function retryable(err: unknown): boolean {
  if (err instanceof Anthropic.BadRequestError) return false
  if (err instanceof Anthropic.AuthenticationError) return false
  if (err instanceof Anthropic.PermissionDeniedError) return false
  if (err instanceof Anthropic.NotFoundError) return false
  if (err instanceof Anthropic.UnprocessableEntityError) return false
  return true
}

function describe(err: unknown): string {
  if (err instanceof Anthropic.APIError && err.status) return `HTTP ${err.status}`
  if (err instanceof Anthropic.APIConnectionError) return 'connection dropped'
  return (err as Error).message?.slice(0, 80) ?? 'unknown error'
}

function requestParams(req: ModelRequest, model: string) {
  const base = {
    model,
    max_tokens: req.maxTokens,
    system: req.system,
    ...(req.tools.length ? { tools: req.tools } : {}),
    messages: req.messages,
    // Caches the growing conversation as well as the fixed prefix, so each
    // step of a multi-step turn re-reads the previous steps from cache.
    cache_control: { type: 'ephemeral' as const },
    ...(req.toolChoice === 'none' ? { tool_choice: { type: 'none' as const } } : {}),
  }
  if (!isReal) return base
  return {
    ...base,
    thinking: { type: 'adaptive' as const },
    output_config: { effort: 'medium' as const },
    // Server-side refusal fallback: a policy decline is re-run on another model inside the same call.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default' as const,
  }
}

export async function callModel(req: ModelRequest, hooks: ModelHooks, signal: AbortSignal): Promise<ModelReply> {
  const started = Date.now()
  const plan = [
    ...Array.from({ length: config.model.attemptsPerModel }, () => config.model.primary),
    ...Array.from({ length: 2 }, () => config.model.fallback),
  ]
  let lastError: unknown
  for (const [attempt, model] of plan.entries()) {
    if (signal.aborted) throw new CancelledError()
    if (attempt > 0 && model === config.model.fallback && plan[attempt - 1] !== model) {
      hooks.onRetry(`${config.model.primary} kept failing; switching to the fallback model ${model}`)
    }
    let emitted = false
    const callStarted = Date.now()
    try {
      const stream = anthropic.beta.messages.stream(requestParams(req, model) as Anthropic.Beta.Messages.MessageCreateParamsStreaming, { signal })
      stream.on('text', (delta) => {
        emitted = true
        hooks.onText(delta)
      })
      const message = await stream.finalMessage()
      modelCalls.observe({ model, outcome: message.stop_reason ?? 'unknown' }, (Date.now() - callStarted) / 1000)
      modelTokens.inc({ kind: 'input' }, message.usage.input_tokens)
      modelTokens.inc({ kind: 'output' }, message.usage.output_tokens)
      modelTokens.inc({ kind: 'cache_read' }, message.usage.cache_read_input_tokens ?? 0)
      modelTokens.inc({ kind: 'cache_write' }, message.usage.cache_creation_input_tokens ?? 0)
      return { message, model, attempts: attempt + 1, fallbackUsed: model !== config.model.primary, latencyMs: Date.now() - started }
    } catch (err) {
      if (signal.aborted || err instanceof Anthropic.APIUserAbortError) throw new CancelledError()
      modelCalls.observe({ model, outcome: 'error' }, (Date.now() - callStarted) / 1000)
      lastError = err
      if (emitted) hooks.onDiscard(`The ${model} stream broke partway (${describe(err)}); redoing this step`)
      if (!retryable(err)) throw err
      const delay = Math.min(4000, 400 * 2 ** (attempt % config.model.attemptsPerModel))
      log.warn({ model, attempt: attempt + 1, err: describe(err), delay }, 'model call failed, retrying')
      if (attempt + 1 < plan.length) {
        hooks.onRetry(`${model}: ${describe(err)}; retrying in ${(delay / 1000).toFixed(1)}s`)
        await sleep(delay, signal)
      }
    }
  }
  throw new ModelUnavailableError(`The model is unavailable right now (${describe(lastError)}). Try again in a moment.`)
}

/** A short structured-output call, used by the prefetch step to rewrite the request into search queries. */
export async function callStructured<T>(system: string, user: string, schema: Record<string, unknown>, signal: AbortSignal): Promise<T | null> {
  try {
    const message = await anthropic.beta.messages.create(
      {
        model: isReal ? process.env.MODEL_REWRITE || 'claude-haiku-5-5' : config.model.primary,
        max_tokens: 1024,
        system,
        messages: [{ role: 'user', content: user }],
        output_config: { format: { type: 'json_schema', schema } },
      } as Anthropic.Beta.Messages.MessageCreateParamsNonStreaming,
      { signal, timeout: 10_000 },
    )
    const text = message.content.find((b) => b.type === 'text')
    return text && text.type === 'text' ? (JSON.parse(text.text) as T) : null
  } catch (err) {
    if (signal.aborted) throw new CancelledError()
    log.warn({ err: describe(err) }, 'structured call failed; continuing without it')
    return null
  }
}
