import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { createBackendApp } from './app.js'
import { Engine } from './engine.js'

function make() {
  const engine = new Engine({
    model: 'mock-large', version: 'v1', slots: 2, ttftMs: 0, prefillMsPerToken: 0, tokensPerSecond: 1000, admitOverheadMs: 0,
    cacheEntries: 4, batching: 'continuous', restartMs: 100, crashAfterTokens: 3, slowExtraMs: 0,
  })
  return { engine, app: createBackendApp(engine, 'b1') }
}
const item = (id: string) => ({ id, prefixKey: 'p', prefixTokens: 10, inputTokens: 20, maxTokens: 50, seed: id, outputTokens: 3 })

describe('mock backend HTTP', () => {
  it('admits a group and streams NDJSON events until every item is done', async () => {
    const { engine, app } = make()
    const timer = setInterval(() => engine.step(Date.now()), 5)
    const r = await request(app).post('/v1/batch').send({ batchId: 'g1', items: [item('a'), item('b'), item('c')] })
    clearInterval(timer)
    const lines = r.text.trim().split('\n').map((l) => JSON.parse(l))
    expect(lines[0]).toMatchObject({ t: 'admitted', ids: ['a', 'b'], rejected: [{ id: 'c', reason: 'no_slot' }], backend: 'b1' })
    expect(lines.filter((l) => l.t === 'done').map((l) => l.id).sort()).toEqual(['a', 'b'])
  })

  it('refuses with 503 while draining and 529 when overload is armed', async () => {
    const { app } = make()
    await request(app).post('/admin/drain').send({ draining: true })
    const r1 = await request(app).post('/v1/batch').send({ batchId: 'g1', items: [item('a')] })
    expect(r1.status).toBe(503)
    expect(r1.body.reason).toBe('draining')
    await request(app).post('/admin/drain').send({ draining: false })
    await request(app).put('/admin/settings').send({ chaos: { overload: 1 } })
    const r2 = await request(app).post('/v1/batch').send({ batchId: 'g2', items: [item('a')] })
    expect(r2.status).toBe(529)
    expect((await request(app).get('/health')).body.chaos.overload).toBe(0)
  })

  it('reports version, slots and cache in health', async () => {
    const { app } = make()
    const h = (await request(app).get('/health')).body
    expect(h).toMatchObject({ id: 'b1', status: 'ok', version: 'v1', slots: 2, inUse: 0 })
  })
})
