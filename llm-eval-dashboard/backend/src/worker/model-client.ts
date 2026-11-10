/**
 * Calls the model over SSE (fetch + ReadableStream) and the judge over JSON,
 * and turns every way a call can fail into a classified CallFailure.
 *
 * A real provider adapter would implement the same `callModel` signature;
 * none is wired in (see architecture.md, Implementation Notes).
 * @module worker/model-client
 */
import { classifyHttpFailure, parseRetryAfter, type CallFailure } from '../shared/retry.js'

export interface ModelRequest {
  model: string
  system: string
  prompt: string
  temperature: number
  maxTokens: number
  seed: number
}

export type ModelResult =
  | { ok: true; text: string; finishReason: string; inputTokens: number; outputTokens: number; ttftMs: number; generationMs: number }
  | { ok: false; failure: CallFailure; partial: string; aborted: false | string }

export interface CallOptions {
  baseUrl: string
  timeoutMs: number
  /** Aborted by the worker for cancellation or a lost lease; the reason says which. */
  signal?: AbortSignal
  runId?: string
  taskId?: string
}

function abortReason(signal: AbortSignal | undefined): string | false {
  if (!signal?.aborted) return false
  const r = signal.reason
  return typeof r === 'string' ? r : r instanceof Error ? r.message : 'aborted'
}

async function errorFromResponse(res: Response): Promise<CallFailure> {
  const body = (await res.json().catch(() => ({}))) as { error?: { type?: string; message?: string } }
  const kind = classifyHttpFailure(res.status, body.error?.type)
  return { kind, httpStatus: res.status, message: body.error?.message ?? res.statusText, retryAfterMs: parseRetryAfter(res.headers.get('retry-after'), Date.now()) }
}

function networkFailure(err: unknown, timedOut: boolean): CallFailure {
  if (timedOut) return { kind: 'timeout', message: 'model call exceeded its deadline' }
  const msg = err instanceof Error ? `${err.message}${err.cause instanceof Error ? `: ${err.cause.message}` : ''}` : String(err)
  return { kind: 'network', message: msg }
}

export async function callModel(req: ModelRequest, opts: CallOptions): Promise<ModelResult> {
  const timeout = AbortSignal.timeout(opts.timeoutMs)
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout
  const started = performance.now()
  let partial = ''
  let firstTokenAt: number | null = null
  try {
    const res = await fetch(`${opts.baseUrl}/v1/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(opts.runId ? { 'X-Eval-Run-Id': opts.runId } : {}), ...(opts.taskId ? { 'X-Eval-Task-Id': opts.taskId } : {}) },
      body: JSON.stringify(req),
      signal,
    })
    if (!res.ok) return { ok: false, failure: await errorFromResponse(res), partial, aborted: false }
    if (!res.body) return { ok: false, failure: { kind: 'bad_response', message: 'empty body' }, partial, aborted: false }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let sep: number
      while ((sep = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, sep)
        buffer = buffer.slice(sep + 2)
        const event = /^event: (.+)$/m.exec(frame)?.[1]
        const dataLine = /^data: (.*)$/m.exec(frame)?.[1]
        const data = dataLine ? (JSON.parse(dataLine) as Record<string, unknown>) : {}
        if (event === 'token') {
          if (firstTokenAt === null) firstTokenAt = performance.now()
          partial += String(data.text ?? '')
        } else if (event === 'error') {
          return { ok: false, failure: { kind: 'stream_error', message: String(data.message ?? 'error event mid-stream') }, partial, aborted: false }
        } else if (event === 'done') {
          const usage = (data.usage ?? {}) as { inputTokens?: number; outputTokens?: number }
          const end = performance.now()
          const ttft = (firstTokenAt ?? end) - started
          return {
            ok: true,
            text: partial,
            finishReason: String(data.finishReason ?? 'stop'),
            inputTokens: usage.inputTokens ?? 0,
            outputTokens: usage.outputTokens ?? 0,
            ttftMs: Math.round(ttft),
            generationMs: Math.round(end - started - ttft),
          }
        }
      }
    }
    return { ok: false, failure: { kind: 'stream_disconnected', message: 'stream ended before the done event' }, partial, aborted: false }
  } catch (err) {
    const aborted = abortReason(opts.signal)
    if (aborted) return { ok: false, failure: { kind: 'network', message: `aborted: ${aborted}` }, partial, aborted }
    const timedOut = timeout.aborted
    // A socket reset after headers arrived is a mid-stream disconnect, not a connect failure.
    if (!timedOut && partial.length > 0) return { ok: false, failure: { kind: 'stream_disconnected', message: 'connection lost mid-stream' }, partial, aborted: false }
    if (!timedOut && err instanceof TypeError && /terminated|other side closed|socket/i.test(`${err.message} ${String(err.cause)}`)) {
      return { ok: false, failure: { kind: 'stream_disconnected', message: 'connection lost mid-stream' }, partial, aborted: false }
    }
    return { ok: false, failure: networkFailure(err, timedOut), partial, aborted: false }
  }
}

export interface JudgeRequest {
  rubric: string
  strictness: 'lenient' | 'strict'
  passGrade: number
  input: string
  output: string
  reference: string
}

export type JudgeResult =
  | { ok: true; grade: number; score: number; passed: boolean; confidence: number; rationale: string }
  | { ok: false; failure: CallFailure; aborted: false | string }

export async function callJudge(req: JudgeRequest, opts: CallOptions): Promise<JudgeResult> {
  const timeout = AbortSignal.timeout(opts.timeoutMs)
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout
  try {
    const res = await fetch(`${opts.baseUrl}/v1/judge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(opts.runId ? { 'X-Eval-Run-Id': opts.runId } : {}) },
      body: JSON.stringify(req),
      signal,
    })
    if (!res.ok) return { ok: false, failure: await errorFromResponse(res), aborted: false }
    const body = (await res.json()) as { grade: number; score: number; passed: boolean; confidence: number; rationale: string }
    return { ok: true, ...body }
  } catch (err) {
    const aborted = abortReason(opts.signal)
    if (aborted) return { ok: false, failure: { kind: 'network', message: `aborted: ${aborted}` }, aborted }
    if (!timeout.aborted && err instanceof Error && /terminated|other side closed|socket|JSON/i.test(`${err.message} ${String(err.cause)}`)) {
      return { ok: false, failure: { kind: 'stream_disconnected', message: 'judge connection lost' }, aborted: false }
    }
    return { ok: false, failure: networkFailure(err, timeout.aborted), aborted: false }
  }
}
