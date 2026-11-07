import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { createEmbedderApp, defaultEmbedderSettings } from './app.js'
import { cosine, embed, EMBEDDING_DIMS } from './embed.js'

describe('mock embedding', () => {
  it('is deterministic and L2-normalized', () => {
    const a = embed('Submit expense claims within 30 days')
    expect(a).toHaveLength(EMBEDDING_DIMS)
    expect(embed('Submit expense claims within 30 days')).toEqual(a)
    expect(Math.abs(Math.hypot(...a) - 1)).toBeLessThan(1e-3)
  })

  it('puts related text closer than unrelated text', () => {
    const q = embed('How do I get reimbursed for receipts?')
    const related = embed('Submit expense claims with an itemized receipt in the finance portal.')
    const unrelated = embed('The primary on-call engineer must acknowledge a page within 5 minutes.')
    expect(cosine(q, related)).toBeGreaterThan(cosine(q, unrelated) + 0.1)
  })

  it('treats morphological variants as near neighbours', () => {
    expect(cosine(embed('backup snapshots'), embed('backups snapshot'))).toBeGreaterThan(0.8)
  })
})

describe('mock embedder service', () => {
  it('embeds a batch', async () => {
    const app = createEmbedderApp({ ...defaultEmbedderSettings(), latencyMs: 0 })
    const res = await request(app).post('/v1/embeddings').send({ inputs: ['a b c', 'd e f'] })
    expect(res.status).toBe(200)
    expect(res.body.vectors).toHaveLength(2)
    expect(res.body.vectors[0]).toEqual(embed('a b c'))
  })

  it('answers armed 429s with Retry-After, then recovers', async () => {
    const settings = { ...defaultEmbedderSettings(), latencyMs: 0 }
    const app = createEmbedderApp(settings)
    await request(app).put('/_control/settings').send({ armed: { rate_limited: 2 }, retryAfterSeconds: 2 }).expect(200)
    const first = await request(app).post('/v1/embeddings').send({ inputs: ['x'] })
    expect(first.status).toBe(429)
    expect(first.headers['retry-after']).toBe('2')
    expect((await request(app).post('/v1/embeddings').send({ inputs: ['x'] })).status).toBe(429)
    expect((await request(app).post('/v1/embeddings').send({ inputs: ['x'] })).status).toBe(200)
  })

  it('fails armed server errors', async () => {
    const app = createEmbedderApp({ ...defaultEmbedderSettings(), latencyMs: 0, armed: { rate_limited: 0, server_error: 1 } })
    expect((await request(app).post('/v1/embeddings').send({ inputs: ['x'] })).status).toBe(500)
    expect((await request(app).post('/v1/embeddings').send({ inputs: ['x'] })).status).toBe(200)
  })
})
