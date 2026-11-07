import { describe, expect, it, vi } from 'vitest'
import { embedBatch, EmbedError } from './embed-client.js'
import { backoffMs, jobKey } from './jobs.js'

function fakeFetch(responses: { status: number; retryAfter?: string }[]) {
  let i = 0
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const r = responses[Math.min(i++, responses.length - 1)]
    const inputs = (JSON.parse(String(init?.body)) as { inputs: string[] }).inputs
    const body = r.status === 200 ? JSON.stringify({ model: 'mock', vectors: inputs.map(() => [1]) }) : JSON.stringify({ error: { type: 'x' } })
    return new Response(body, { status: r.status, headers: r.retryAfter ? { 'Retry-After': r.retryAfter } : {} })
  }) as unknown as typeof fetch
}

describe('embedder client', () => {
  it('retries 429s inside the attempt, honouring Retry-After', async () => {
    const waits: number[] = []
    const r = await embedBatch(['a', 'b'], {
      url: 'http://x',
      fetchImpl: fakeFetch([{ status: 429, retryAfter: '2' }, { status: 429 }, { status: 200 }]),
      sleep: async (ms) => void waits.push(ms),
    })
    expect(r.vectors).toHaveLength(2)
    expect(r.rateLimitedRetries).toBe(2)
    expect(waits[0]).toBe(2000)
    expect(waits[1]).toBeGreaterThan(0)
  })

  it('fails the attempt on a 500 without retrying', async () => {
    const f = fakeFetch([{ status: 500 }, { status: 200 }])
    await expect(embedBatch(['a'], { url: 'http://x', fetchImpl: f, sleep: async () => undefined })).rejects.toBeInstanceOf(EmbedError)
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('gives up on 429 after the retry budget', async () => {
    await expect(embedBatch(['a'], { url: 'http://x', retries: 2, fetchImpl: fakeFetch([{ status: 429 }]), sleep: async () => undefined })).rejects.toThrow(/429/)
  })
})

describe('job helpers', () => {
  it('keys pipeline stages by version and document-level work by document', () => {
    expect(jobKey('chunk', 'doc_1', 'ver_1')).toBe('ver_1:chunk')
    expect(jobKey('purge', 'doc_1', null)).toBe('doc_1:purge')
    expect(jobKey('sync_acl', 'doc_1', 'ver_1')).toBe('doc_1:sync_acl')
  })

  it('backs off exponentially with equal jitter, capped', () => {
    expect(backoffMs(1, 1000, 15000, () => 0)).toBe(500)
    expect(backoffMs(1, 1000, 15000, () => 1)).toBe(1000)
    expect(backoffMs(3, 1000, 15000, () => 1)).toBe(4000)
    expect(backoffMs(10, 1000, 15000, () => 1)).toBe(15000)
  })
})
