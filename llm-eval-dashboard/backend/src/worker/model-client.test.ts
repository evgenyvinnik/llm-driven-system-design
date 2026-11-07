/**
 * The worker's model/judge clients against the real mock services on
 * ephemeral ports: every failure mode must come back classified correctly,
 * because retry vs record depends on it.
 */
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createJudgeApp } from '../judge/app.js'
import { createModelApp } from '../model/app.js'
import { isTransient } from '../shared/retry.js'
import { callJudge, callModel, type ModelRequest } from './model-client.js'

let modelServer: Server
let judgeServer: Server
let modelUrl = ''
let judgeUrl = ''
const model = createModelApp({ ttftMs: 5, tokensPerSecond: 2000 })
const judge = createJudgeApp({ latencyMs: 5, retryAfterSeconds: 2 })

beforeAll(async () => {
  modelServer = model.app.listen(0)
  judgeServer = judge.app.listen(0)
  await Promise.all([new Promise((r) => modelServer.once('listening', r)), new Promise((r) => judgeServer.once('listening', r))])
  modelUrl = `http://127.0.0.1:${(modelServer.address() as AddressInfo).port}`
  judgeUrl = `http://127.0.0.1:${(judgeServer.address() as AddressInfo).port}`
})
afterAll(() => {
  modelServer.closeAllConnections()
  judgeServer.closeAllConnections()
  modelServer.close()
  judgeServer.close()
})
beforeEach(() => {
  model.chaos.reset()
  judge.chaos.reset()
})

const req: ModelRequest = { model: 'mock-small', system: 'You are a support triage assistant.', prompt: 'Classify the support ticket.\nCategories: billing, other\nRespond with only the category name.\n\nTicket: I was charged twice.', temperature: 0, maxTokens: 50, seed: 1 }
const opts = () => ({ baseUrl: modelUrl, timeoutMs: 2000, runId: 'run_test' })

describe('callModel', () => {
  it('streams a completion with usage and latency split', async () => {
    const r = await callModel(req, opts())
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.text).toBe('billing')
      expect(r.outputTokens).toBe(1)
      expect(r.inputTokens).toBeGreaterThan(10)
      expect(r.ttftMs).toBeGreaterThanOrEqual(0)
    }
    expect(model.stats.snapshot('run_test').run?.calls).toBeGreaterThan(0)
  })

  it('429 is transient and carries Retry-After', async () => {
    model.settings.retryAfterSeconds = 2
    model.chaos.arm({ rate_limit: 1 })
    const r = await callModel(req, opts())
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failure).toMatchObject({ kind: 'rate_limited', httpStatus: 429, retryAfterMs: 2000 })
      expect(isTransient(r.failure.kind)).toBe(true)
    }
  })

  it('529 overload is transient', async () => {
    model.chaos.arm({ overloaded: 1 })
    const r = await callModel(req, opts())
    expect(!r.ok && r.failure.kind).toBe('overloaded')
  })

  it('a mid-stream disconnect is transient, keeping the partial text', async () => {
    model.chaos.arm({ disconnect: 1 })
    const long = { ...req, prompt: 'Explain HTTP status code 404.', maxTokens: 200 }
    const r = await callModel(long, opts())
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failure.kind).toBe('stream_disconnected')
      expect(r.partial.length).toBeGreaterThan(0)
    }
  })

  it('a hang hits the client deadline and is classified as a timeout', async () => {
    model.chaos.arm({ timeout: 1 })
    const r = await callModel(req, { ...opts(), timeoutMs: 300 })
    expect(!r.ok && r.failure.kind).toBe('timeout')
  })

  it('400s are permanent: invalid request and context overflow', async () => {
    model.chaos.arm({ invalid: 1 })
    const a = await callModel(req, opts())
    expect(!a.ok && a.failure.kind).toBe('invalid_request')
    const b = await callModel({ ...req, model: 'mock-tiny', prompt: 'x'.repeat(2000) }, opts())
    expect(!b.ok && b.failure.kind).toBe('context_length_exceeded')
    expect(!b.ok && isTransient(b.failure.kind)).toBe(false)
  })

  it('an abort (cancel) is reported as such and stops the mock', async () => {
    const controller = new AbortController()
    model.settings.ttftMs = 400
    const pending = callModel(req, { ...opts(), signal: controller.signal })
    setTimeout(() => controller.abort('cancelled'), 50)
    const r = await pending
    model.settings.ttftMs = 5
    expect(!r.ok && r.aborted).toBe('cancelled')
  })

  it('a refused connection is a transient network failure', async () => {
    const r = await callModel(req, { baseUrl: 'http://127.0.0.1:1', timeoutMs: 1000 })
    expect(!r.ok && r.failure.kind).toBe('network')
  })
})

describe('callJudge', () => {
  const j = { rubric: 'r', strictness: 'lenient' as const, passGrade: 4, input: '', output: '404 Not Found: the server cannot find the requested resource.', reference: '404 Not Found: the server cannot find the requested resource.' }

  it('returns a deterministic verdict', async () => {
    const r = await callJudge(j, { baseUrl: judgeUrl, timeoutMs: 2000 })
    expect(r).toMatchObject({ ok: true, grade: 5, passed: true })
  })

  it('classifies judge failures like model failures', async () => {
    judge.chaos.arm({ rate_limit: 1, disconnect: 1 })
    const a = await callJudge(j, { baseUrl: judgeUrl, timeoutMs: 2000 })
    expect(!a.ok && a.failure).toMatchObject({ kind: 'rate_limited', retryAfterMs: 2000 })
    const b = await callJudge(j, { baseUrl: judgeUrl, timeoutMs: 2000 })
    expect(!b.ok && isTransient(b.failure.kind)).toBe(true)
  })
})
