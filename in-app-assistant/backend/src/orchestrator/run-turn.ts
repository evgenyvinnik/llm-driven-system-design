/**
 * The agent loop.
 *
 * The model keeps no memory between calls, so each pass sends it the whole
 * conversation so far. It either answers or asks for tools; the loop runs the
 * tools, adds their results, and calls it again. Nearly everything here is
 * what surrounds those steps: limits, retries, validation, policy, waiting
 * without holding a worker, and recording every step.
 *
 *   setup ─▶ ┌─▶ call model ─▶ end_turn? ──────────────────────────▶ complete
 *            │        │        budget/cancel? ─▶ wrap-up (tools off) ─▶ complete
 *            │        │        max_tokens? ─▶ "continue" / retry with room
 *            │        ▼
 *            └── run tools: validate ─▶ policy ─▶ (confirm? suspend)
 *                           ─▶ client tool? suspend ─▶ execute (OBO, idempotency key) ─▶ shrink
 *
 * "Suspend" saves the turn and returns. The turn resumes on whichever API
 * instance receives the browser's tool result or the user's confirmation.
 * @module orchestrator/run-turn
 */
import { config } from '../shared/config.js'
import { pool } from '../shared/db.js'
import { shortId } from '../shared/ids.js'
import { childLogger } from '../shared/logger.js'
import { policyDecisions, toolCalls, turnDuration, turnsFinished } from '../shared/metrics.js'
import { mintOboToken } from '../shared/obo.js'
import { estimateTokens } from '../shared/tokens.js'
import { principalsFor } from '../retrieval/principals.js'
import { getTool, toApiTools, toolsetHash, toolsFor } from '../tools/registry.js'
import { contextFor, executeTool } from '../tools/service.js'
import { shrink } from '../tools/shrink.js'
import { effectOf, ToolError, type App, type CallFacts, type ToolSpec } from '../tools/types.js'
import { validateArgs } from '../tools/validate.js'
import { assembleHistory, buildTurnMessage, compactTurn, CONTINUE_MESSAGE, SYSTEM_BLOCKS, SYSTEM_PROMPT, verifyCitations, wrapUpMessage, type History } from './context.js'
import { emit, TextBuffer, type TurnEventType } from './events.js'
import { callModel, CancelledError, ModelUnavailableError, type MessageContent, type MessageParam, type ToolUnion } from './model-client.js'
import { decide } from './policy.js'
import { prefetch } from './prefetch.js'
import {
  checkpoint,
  extendLease,
  finishTurn,
  LeaseLostError,
  loadTurn,
  recordStep,
  suspend,
  type Batch,
  type BatchCall,
  type Turn,
} from './turn-store.js'

const log = childLogger('orchestrator')

export interface UserSettings {
  confirm_writes: boolean
  block_external_after_untrusted: boolean
  allow_send: boolean
  allow_doc_edits: boolean
  prefetch: boolean
  max_steps: number
}

interface Env {
  turn: Turn
  app: App
  user: { id: string; displayName: string; email: string; orgId: string; timezone: string }
  settings: UserSettings
  tools: ToolSpec[]
  apiTools: ToolUnion[]
  history: History
  obo: string
  abort: AbortController
  started: number
  text: TextBuffer
  maxTokens: number
}

type CallOutcome =
  | { kind: 'result'; content: string; isError: boolean }
  | { kind: 'suspend'; status: 'waiting_client' | 'waiting_confirmation'; waiting: NonNullable<Batch['waiting']>; event: [TurnEventType, Record<string, unknown>] }
  | { kind: 'loop' }

/** Turns this instance is running right now, so a cancel can abort the model stream. */
const running = new Map<string, AbortController>()

export function abortLocal(turnId: string): boolean {
  const controller = running.get(turnId)
  controller?.abort('cancelled')
  return !!controller
}

export function runningCount(): number {
  return running.size
}

/** Starts (or resumes) a turn this instance has claimed. Never throws to the caller. */
export function startDrive(turnId: string): Promise<void> {
  return drive(turnId).catch((err) => log.error({ err, turnId }, 'drive crashed'))
}

async function drive(turnId: string): Promise<void> {
  const abort = new AbortController()
  running.set(turnId, abort)
  const heartbeat = setInterval(() => {
    extendLease(turnId)
      .then((held) => !held && abort.abort('lease lost'))
      .catch(() => undefined)
  }, config.turn.heartbeatMs)
  const started = Date.now()
  let env: Env | null = null
  try {
    const turn = await loadTurn(turnId)
    if (!turn || turn.status !== 'running') return
    env = await buildEnv(turn, abort, started)
    await emit(turnId, 'turn.status', { status: 'running' })
    await loop(env)
  } catch (err) {
    if (err instanceof LeaseLostError || abort.signal.reason === 'lease lost') {
      log.warn({ turnId }, 'lease lost; another instance owns this turn now')
      return
    }
    if (err instanceof CancelledError || abort.signal.aborted) {
      await finishCancelled(turnId, env, started)
      return
    }
    log.error({ err, turnId }, 'turn failed')
    const message = err instanceof ModelUnavailableError ? err.message : 'Something went wrong while working on this. Please try again.'
    await env?.text.flush()
    const done = await finishTurn(turnId, { status: 'failed', finalText: null, citations: [], errorCode: err instanceof ModelUnavailableError ? 'MODEL_UNAVAILABLE' : 'INTERNAL', errorMessage: message, activeMs: Date.now() - started }, {})
    if (done) {
      turnsFinished.inc({ app: env?.app ?? 'unknown', status: 'failed' })
      await emit(turnId, 'turn.end', { status: 'failed', errorMessage: message })
    }
  } finally {
    clearInterval(heartbeat)
    running.delete(turnId)
  }
}

async function buildEnv(turn: Turn, abort: AbortController, started: number): Promise<Env> {
  const { rows: [conversation] } = await pool.query<{ app: App }>('SELECT app FROM conversations WHERE id = $1', [turn.conversation_id])
  const { rows: [user] } = await pool.query<{ id: string; display_name: string; email: string; org_id: string; timezone: string }>(
    'SELECT id, display_name, email, org_id, timezone FROM users WHERE id = $1',
    [turn.user_id],
  )
  const { rows: [settingsRow] } = await pool.query<UserSettings>('SELECT * FROM user_settings WHERE user_id = $1', [turn.user_id])
  const settings: UserSettings = settingsRow ?? {
    confirm_writes: false,
    block_external_after_untrusted: false,
    allow_send: true,
    allow_doc_edits: true,
    prefetch: true,
    max_steps: config.turn.maxStepsDefault,
  }
  // Only tools that fit this app and these settings exist for the model.
  const tools = toolsFor(conversation.app, settings)
  const hash = toolsetHash(tools)
  const { rows: prior } = await pool.query<Turn>(
    `SELECT messages, status, user_text, final_text, tainted, toolset_hash, sources FROM turns
      WHERE conversation_id = $1 AND seq < $2 AND status IN ('completed', 'failed', 'cancelled') ORDER BY seq`,
    [turn.conversation_id, turn.seq],
  )
  const history = assembleHistory(prior, config.turn.historyBudgetTokens, hash)
  // Content read in earlier turns is still in the context, so its taint carries over.
  turn.tainted ||= history.tainted
  turn.toolset_hash = hash
  return {
    turn,
    app: conversation.app,
    user: { id: user.id, displayName: user.display_name, email: user.email, orgId: user.org_id, timezone: user.timezone },
    settings,
    tools,
    apiTools: toApiTools(tools),
    history,
    obo: mintOboToken({ sub: user.id, org: user.org_id, email: user.email, tz: user.timezone, turn: turn.id, scopes: tools.map((t) => t.name) }),
    abort,
    started,
    text: new TextBuffer(turn.id),
    maxTokens: config.model.maxTokens,
  }
}

const activeMs = (env: Env) => Date.now() - env.started

function budgetExhausted(env: Env): string | null {
  if (env.turn.steps >= env.settings.max_steps) return `the step limit (${env.settings.max_steps} model calls) was reached`
  if (env.turn.output_tokens >= config.turn.maxOutputTokens) return 'the output token budget was used up'
  if (env.turn.active_ms + activeMs(env) >= config.turn.deadlineSeconds * 1000) return `the ${config.turn.deadlineSeconds}-second time limit was reached`
  return null
}

async function notice(env: Env, kind: string, message: string, detail: Record<string, unknown> = {}): Promise<void> {
  await env.text.flush()
  await emit(env.turn.id, 'notice', { kind, message })
  await recordStep(env.turn.id, { step: env.turn.steps, kind: 'notice', name: kind, detail: { message, ...detail } })
}

/** Setup before the first model call: optional prefetch, then the turn's first message. */
async function startTurnMessages(env: Env): Promise<void> {
  const { turn } = env
  let block: string | null = null
  if (env.settings.prefetch) {
    const principals = await principalsFor(pool, env.user.id, env.user.orgId)
    const draft = buildTurnMessage(turn, env.user, env.app, null)
    // Earlier turns as plain "User:/Assistant:" lines, so the rewriter can resolve "she" and "it".
    const historyText = env.history.messages
      .map((m) => {
        const text = typeof m.content === 'string' ? m.content : m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n')
        const request = /<user_request>([\s\S]*?)<\/user_request>/.exec(text)?.[1]?.trim()
        if (m.role === 'user') return request ? `User: ${request}` : /<earlier_conversation>/.test(text) ? text.replace(/<\/?earlier_conversation>/g, '').trim() : ''
        return text.trim() ? `Assistant: ${text.trim()}` : ''
      })
      .filter(Boolean)
      .join('\n')
      .slice(-4000)
    const result = await prefetch({
      userId: env.user.id,
      orgId: env.user.orgId,
      email: env.user.email,
      timezone: env.user.timezone,
      principals,
      turnMessageText: (draft.content as { text: string }[])[0].text,
      historyText,
      signal: env.abort.signal,
    })
    await recordStep(turn.id, {
      step: 0,
      kind: 'prefetch',
      name: result ? 'retrieved' : 'skipped',
      detail: result ? { queries: result.rewrite.queries, filters: result.rewrite.filters, passages: result.passages.map((p) => p.sourceId) } : {},
      latencyMs: result?.ms,
    })
    if (result) {
      block = result.block
      Object.assign(turn.sources, result.sources)
      if (result.untrusted) turn.tainted = true
      await emit(turn.id, 'tool.result', {
        callId: 'prefetch',
        name: 'prefetch',
        ok: true,
        summary: `Found ${result.passages.length} related item${result.passages.length === 1 ? '' : 's'} before asking the model`,
      })
    }
  }
  turn.messages = [buildTurnMessage(turn, env.user, env.app, block)]
  await checkpoint(turn.id, { messages: turn.messages, tainted: turn.tainted, sources: turn.sources, toolset_hash: turn.toolset_hash })
}

async function loop(env: Env): Promise<void> {
  const { turn } = env
  if (turn.messages.length === 0) await startTurnMessages(env)
  if (turn.batch) {
    const outcome = await processBatch(env)
    if (outcome === 'suspended') return
    if (outcome === 'loop') return wrapUp(env, 'the same tool call kept repeating')
  }

  while (true) {
    if (env.abort.signal.aborted) throw new CancelledError()
    // After a crash, the last checkpoint may already hold the model's reply.
    const last = turn.messages[turn.messages.length - 1]
    if (last?.role === 'assistant') {
      const calls = toolUses(last)
      if (calls.length === 0) return complete(env)
      turn.batch = { calls, results: {}, approved: [] }
      const outcome = await processBatch(env)
      if (outcome === 'suspended') return
      if (outcome === 'loop') return wrapUp(env, 'the same tool call kept repeating')
      continue
    }

    // Context growth: trim older tool results in this turn, never the cached prefix.
    const fixed = estimateTokens(SYSTEM_PROMPT) + estimateTokens(env.apiTools) + estimateTokens(env.history.messages)
    const compacted = compactTurn(turn.messages, fixed, config.turn.contextBudgetTokens)
    if (compacted.removed) {
      turn.messages = compacted.messages
      await recordStep(turn.id, { step: turn.steps, kind: 'compaction', detail: { removed: compacted.removed } })
      await notice(env, 'compaction', `Trimmed ${compacted.removed} older tool result${compacted.removed === 1 ? '' : 's'} to stay within the context budget`)
      await checkpoint(turn.id, { messages: turn.messages })
    }

    const step = turn.steps + 1
    const reply = await callModel(
      { system: SYSTEM_BLOCKS, tools: env.apiTools, messages: [...env.history.messages, ...turn.messages], maxTokens: env.maxTokens },
      modelHooks(env, step),
      env.abort.signal,
    )
    await env.text.flush()
    const message = reply.message
    turn.steps = step
    turn.input_tokens += message.usage.input_tokens + (message.usage.cache_read_input_tokens ?? 0) + (message.usage.cache_creation_input_tokens ?? 0)
    turn.output_tokens += message.usage.output_tokens
    turn.cache_read_tokens += message.usage.cache_read_input_tokens ?? 0
    turn.model = reply.model
    await recordStep(turn.id, {
      step,
      kind: 'model_call',
      name: reply.model,
      detail: { stopReason: message.stop_reason, attempts: reply.attempts, fallbackUsed: reply.fallbackUsed, toolCalls: toolUses({ role: 'assistant', content: message.content }).map((c) => c.name), cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0 },
      latencyMs: reply.latencyMs,
      inputTokens: message.usage.input_tokens + (message.usage.cache_read_input_tokens ?? 0) + (message.usage.cache_creation_input_tokens ?? 0),
      outputTokens: message.usage.output_tokens,
      cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
    })

    const calls = toolUses({ role: 'assistant', content: message.content })
    if (message.stop_reason === 'max_tokens' && calls.length) {
      // A tool call cut off mid-arguments is never run: discard the reply and retry the step with more room.
      env.maxTokens = Math.min(env.maxTokens * 2, 64000)
      await emit(turn.id, 'text.discard', { step, reason: 'tool call cut off' })
      await notice(env, 'max_tokens', `A tool call was cut off at the token limit; retrying with room for ${env.maxTokens} tokens`)
      await checkpoint(turn.id, { steps: turn.steps, input_tokens: turn.input_tokens, output_tokens: turn.output_tokens, cache_read_tokens: turn.cache_read_tokens })
      continue
    }

    turn.messages.push({ role: 'assistant', content: message.content as MessageContent })
    turn.batch = message.stop_reason === 'tool_use' && calls.length ? { calls, results: {}, approved: [] } : null
    const { cancelRequested } = await checkpoint(turn.id, {
      messages: turn.messages,
      batch: turn.batch,
      steps: turn.steps,
      input_tokens: turn.input_tokens,
      output_tokens: turn.output_tokens,
      cache_read_tokens: turn.cache_read_tokens,
      model: turn.model,
    })

    if (message.stop_reason === 'end_turn' || message.stop_reason === 'stop_sequence') return complete(env)
    if (message.stop_reason === 'refusal') return complete(env, { refusal: true })
    if (cancelRequested) throw new CancelledError()
    const exhausted = budgetExhausted(env)
    if (exhausted) return wrapUp(env, exhausted)
    if (message.stop_reason === 'max_tokens') {
      turn.messages.push(CONTINUE_MESSAGE)
      await notice(env, 'max_tokens', 'The reply hit the token limit; asking the model to continue')
      await checkpoint(turn.id, { messages: turn.messages })
      continue
    }
    if (message.stop_reason === 'pause_turn') continue
    if (!turn.batch) return complete(env)

    const outcome = await processBatch(env)
    if (outcome === 'suspended') return
    if (outcome === 'loop') return wrapUp(env, 'the same tool call kept repeating')
  }
}

function modelHooks(env: Env, step: number) {
  return {
    onText: (text: string) => env.text.push(step, text),
    onDiscard: (reason: string) => {
      env.text.drop()
      void env.text.flush().then(() => emit(env.turn.id, 'text.discard', { step, reason }))
    },
    onRetry: (message: string) => void notice(env, 'retry', message),
  }
}

function toolUses(message: MessageParam): BatchCall[] {
  if (typeof message.content === 'string') return []
  return message.content
    .filter((b) => b.type === 'tool_use')
    .map((b) => {
      const block = b as { id: string; name: string; input: unknown }
      return { id: block.id, name: block.name, input: (block.input ?? {}) as Record<string, unknown> }
    })
}

/** Consecutive server-side reads run in parallel; writes, sends and client tools run one at a time, in order. */
function groupCalls(calls: BatchCall[], env: Env): BatchCall[][] {
  const groups: BatchCall[][] = []
  for (const call of calls) {
    const tool = env.tools.find((t) => t.name === call.name)
    const parallel = !!tool && tool.execution === 'server' && effectOf(tool, call.input) === 'read'
    const last = groups[groups.length - 1]
    if (parallel && last && (last as BatchCall[] & { parallel?: boolean }).parallel) last.push(call)
    else {
      const group = [call] as BatchCall[] & { parallel?: boolean }
      group.parallel = parallel
      groups.push(group)
    }
  }
  return groups
}

async function processBatch(env: Env): Promise<'done' | 'suspended' | 'loop'> {
  const { turn } = env
  const batch = turn.batch!
  for (const group of groupCalls(batch.calls, env)) {
    const pending = group.filter((c) => !batch.results[c.id])
    if (pending.length === 0) continue
    if (env.abort.signal.aborted) throw new CancelledError()
    const outcomes = await Promise.all(pending.map((call) => runOne(env, call)))
    for (const [i, outcome] of outcomes.entries()) {
      if (outcome.kind === 'loop') return 'loop'
      if (outcome.kind === 'suspend') {
        batch.waiting = outcome.waiting
        await env.text.flush()
        await suspend(turn.id, outcome.status, { batch, messages: turn.messages, tainted: turn.tainted, sources: turn.sources, toolset_hash: turn.toolset_hash }, activeMs(env))
        // Emitted after the state is saved, so a fast reply always finds the turn waiting.
        await emit(turn.id, outcome.event[0], outcome.event[1])
        await emit(turn.id, 'turn.status', { status: outcome.status })
        turnDuration.observe(activeMs(env) / 1000)
        return 'suspended'
      }
      batch.results[pending[i].id] = { content: outcome.content, isError: outcome.isError }
    }
    // Saved after every group: a crash re-runs only the calls without results.
    const { cancelRequested } = await checkpoint(turn.id, { batch, tainted: turn.tainted, sources: turn.sources })
    if (cancelRequested) throw new CancelledError()
  }
  // Every tool_use needs a tool_result with the same id, failed or not, in one message.
  turn.messages.push({
    role: 'user',
    content: batch.calls.map((c) => ({
      type: 'tool_result' as const,
      tool_use_id: c.id,
      content: batch.results[c.id].content,
      ...(batch.results[c.id].isError ? { is_error: true } : {}),
    })),
  })
  turn.batch = null
  await checkpoint(turn.id, { messages: turn.messages, batch: null })
  return 'done'
}

const stable = (value: unknown): string =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? `{${Object.keys(value as object).sort().map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`).join(',')}}`
    : JSON.stringify(value)

function identicalCalls(env: Env, call: BatchCall): number {
  const key = `${call.name}:${stable(call.input)}`
  return env.turn.messages.flatMap((m) => (m.role === 'assistant' ? toolUses(m) : [])).filter((c) => `${c.name}:${stable(c.input)}` === key).length
}

const errorResult = (content: string): CallOutcome => ({ kind: 'result', content, isError: true })

async function runOne(env: Env, call: BatchCall): Promise<CallOutcome> {
  const { turn } = env
  const tool = env.tools.find((t) => t.name === call.name)
  if (!tool) {
    const hidden = getTool(call.name)
    await recordStep(turn.id, { step: turn.steps, kind: 'tool_call', name: call.name, detail: { callId: call.id, args: call.input, ok: false, error: 'unknown tool' } })
    return errorResult(
      hidden
        ? `No tool named ${call.name} is available here. Available tools: ${env.tools.map((t) => t.name).join(', ')}.`
        : `No tool named ${call.name}. Available tools: ${env.tools.map((t) => t.name).join(', ')}.`,
    )
  }
  const args = structuredClone(call.input)
  const problems = validateArgs(tool.name, tool.inputSchema, args)
  if (problems.length) {
    await recordStep(turn.id, { step: turn.steps, kind: 'tool_call', name: tool.name, detail: { callId: call.id, args: call.input, ok: false, error: problems } })
    return errorResult(`Invalid arguments for ${tool.name}: ${problems.join('; ')}. Fix them and call again.`)
  }

  // Loop detection: the third identical call gets a nudge instead of a result; a fourth ends the turn.
  const repeats = identicalCalls(env, call)
  if (repeats >= 4) return { kind: 'loop' }
  if (repeats === 3) {
    await notice(env, 'loop', `${tool.name} was called with identical arguments three times; nudging the model to stop`)
    return errorResult(`You've called ${tool.name} with identical arguments ${repeats} times in this turn; the result won't change. Answer with what you have, or try a different approach.`)
  }

  let facts: CallFacts | null = null
  if (effectOf(tool, args) !== 'read' && tool.inspect) {
    try {
      facts = await tool.inspect(args, await contextFor(env.obo, call.id))
    } catch (err) {
      if (err instanceof ToolError) return errorResult(err.message)
      throw err
    }
  }
  const decision = decide({ tool, args, facts, tainted: turn.tainted, settings: env.settings })
  policyDecisions.inc({ decision: decision.action, rule: decision.rule })
  if (decision.rule !== 'read') {
    await recordStep(turn.id, { step: turn.steps, kind: 'policy', name: tool.name, detail: { callId: call.id, ...decision, tainted: turn.tainted, externalRecipients: facts?.externalRecipients ?? [] } })
  }
  if (decision.action === 'deny') {
    await emit(turn.id, 'tool.result', { callId: call.id, name: tool.name, ok: false, summary: 'Blocked by policy', error: decision.reason })
    return errorResult(decision.reason)
  }
  if (decision.action === 'confirm' && !turn.batch!.approved.includes(call.id)) {
    const actionId = shortId('act', 10)
    const expiresAt = new Date(Date.now() + config.turn.confirmTimeoutSeconds * 1000)
    const { rows } = await pool.query<{ id: string; expires_at: Date }>(
      `INSERT INTO pending_actions (id, turn_id, call_id, tool, args, preview, reason, tainted, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (turn_id, call_id) DO UPDATE SET status = pending_actions.status
       RETURNING id, expires_at`,
      [actionId, turn.id, call.id, tool.name, JSON.stringify(args), JSON.stringify({ title: facts?.title ?? tool.name, ...(facts?.preview ?? {}) }), decision.reason, turn.tainted, expiresAt],
    )
    return {
      kind: 'suspend',
      status: 'waiting_confirmation',
      waiting: { callId: call.id, kind: 'confirmation', actionId: rows[0].id },
      event: [
        'action.proposed',
        { actionId: rows[0].id, callId: call.id, tool: tool.name, title: facts?.title ?? tool.name, preview: facts?.preview ?? {}, reason: decision.reason, rule: decision.rule, tainted: turn.tainted, expiresAt: rows[0].expires_at },
      ],
    }
  }

  await env.text.flush()
  await emit(turn.id, 'tool.status', { callId: call.id, name: tool.name, label: tool.statusLabel(args) })
  if (tool.execution === 'client') {
    return { kind: 'suspend', status: 'waiting_client', waiting: { callId: call.id, kind: 'client' }, event: ['tool.request', { callId: call.id, name: tool.name, input: args }] }
  }

  const started = Date.now()
  const result = await executeTool({ tool, args, callId: call.id, oboToken: env.obo, idempotencyKey: `${turn.id}:${call.id}` })
  const ms = Date.now() - started
  toolCalls.observe({ tool: tool.name, outcome: result.ok ? 'ok' : 'error' }, ms / 1000)
  if (!result.ok) {
    await emit(turn.id, 'tool.result', { callId: call.id, name: tool.name, ok: false, summary: 'Failed', error: result.error })
    await recordStep(turn.id, { step: turn.steps, kind: 'tool_call', name: tool.name, detail: { callId: call.id, args, ok: false, error: result.error }, latencyMs: ms })
    return errorResult(result.error)
  }
  const output = result.output
  if (output.untrusted && !turn.tainted) {
    turn.tainted = true
    await notice(env, 'untrusted', 'Read content from outside your control; sending anything outside your organization now needs your confirmation')
  }
  for (const source of output.sources ?? []) turn.sources[source.id] = source
  const shaped = shrink(output.content, config.turn.toolResultMaxTokens)
  await emit(turn.id, 'tool.result', { callId: call.id, name: tool.name, ok: true, summary: output.summary, replayed: result.replayed, sources: output.sources ?? [] })
  await recordStep(turn.id, {
    step: turn.steps,
    kind: 'tool_call',
    name: tool.name,
    detail: { callId: call.id, args, ok: true, summary: output.summary, untrusted: !!output.untrusted, replayed: result.replayed, trimmed: shaped.trimmed, policy: decision.rule },
    latencyMs: ms,
  })
  return { kind: 'result', content: JSON.stringify(shaped.content), isError: false }
}

/** Budget ran out: one last call with tools off (tool_choice "none" keeps the cached prefix intact). */
async function wrapUp(env: Env, reason: string): Promise<void> {
  const { turn } = env
  const last = turn.messages[turn.messages.length - 1]
  const outstanding = last?.role === 'assistant' ? toolUses(last).map((c) => ({ id: c.id, result: turn.batch?.results[c.id] })) : []
  turn.batch = null
  turn.messages.push(wrapUpMessage(reason, outstanding))
  await notice(env, 'budget', `Stopping: ${reason}. Asking for a summary of what was done.`)
  await recordStep(turn.id, { step: turn.steps, kind: 'wrap_up', detail: { reason } })
  const step = turn.steps + 1
  const reply = await callModel(
    { system: SYSTEM_BLOCKS, tools: env.apiTools, messages: [...env.history.messages, ...turn.messages], maxTokens: env.maxTokens, toolChoice: 'none' },
    modelHooks(env, step),
    env.abort.signal,
  )
  await env.text.flush()
  turn.steps = step
  turn.output_tokens += reply.message.usage.output_tokens
  turn.input_tokens += reply.message.usage.input_tokens + (reply.message.usage.cache_read_input_tokens ?? 0)
  turn.cache_read_tokens += reply.message.usage.cache_read_input_tokens ?? 0
  turn.messages.push({ role: 'assistant', content: reply.message.content.filter((b) => b.type !== 'tool_use') as MessageContent })
  await recordStep(turn.id, { step, kind: 'model_call', name: reply.model, detail: { stopReason: reply.message.stop_reason, wrapUp: true }, latencyMs: reply.latencyMs, outputTokens: reply.message.usage.output_tokens, cacheReadTokens: reply.message.usage.cache_read_input_tokens ?? 0 })
  return complete(env, { wrappedUp: reason })
}

/** What the user saw: every assistant text block of the turn, with continuations joined seamlessly. */
function turnText(messages: MessageParam[]): string {
  let out = ''
  let continuing = false
  for (const m of messages) {
    if (m.role === 'user') {
      const text = typeof m.content === 'string' ? m.content : m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('')
      continuing = /continue where you left off/i.test(text)
      continue
    }
    const text = typeof m.content === 'string' ? m.content : m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('')
    if (!text) continue
    out += out && !continuing ? `\n\n${text}` : text
    continuing = false
  }
  return out.trim()
}

async function complete(env: Env, opts: { refusal?: boolean; wrappedUp?: string } = {}): Promise<void> {
  const { turn } = env
  let finalText = turnText(turn.messages)
  if (opts.refusal) finalText = `${finalText}\n\nI can't help with that request.`.trim()
  const citations = verifyCitations(finalText, { ...env.history.sources, ...turn.sources })
  const done = await finishTurn(
    turn.id,
    { status: 'completed', finalText, citations, activeMs: activeMs(env) },
    { messages: turn.messages, batch: null, steps: turn.steps, input_tokens: turn.input_tokens, output_tokens: turn.output_tokens, cache_read_tokens: turn.cache_read_tokens, tainted: turn.tainted, sources: turn.sources, toolset_hash: turn.toolset_hash },
  )
  if (!done) throw new LeaseLostError(turn.id)
  turnsFinished.inc({ app: env.app, status: 'completed' })
  turnDuration.observe((turn.active_ms + activeMs(env)) / 1000)
  await emit(turn.id, 'turn.end', {
    status: 'completed',
    finalText,
    citations,
    refusal: !!opts.refusal,
    wrappedUp: opts.wrappedUp ?? null,
    usage: { steps: turn.steps, inputTokens: turn.input_tokens, outputTokens: turn.output_tokens, cacheReadTokens: turn.cache_read_tokens },
  })
}

async function finishCancelled(turnId: string, env: Env | null, started: number): Promise<void> {
  await env?.text.flush()
  const finalText = env ? turnText(env.turn.messages) : null
  const done = await finishTurn(turnId, { status: 'cancelled', finalText, citations: [], activeMs: Date.now() - started }, env ? { steps: env.turn.steps, output_tokens: env.turn.output_tokens } : {})
  if (done) {
    turnsFinished.inc({ app: env?.app ?? 'unknown', status: 'cancelled' })
    await emit(turnId, 'turn.end', { status: 'cancelled', finalText })
  }
}
