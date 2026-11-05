import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { createVendorApp } from './app.js'

const body = { trainId: 'T01', locationId: 'GAL', optionId: 'GAL-DTL', gallons: 3000, perUnit: [{ locomotiveId: '6012', gallons: 3000 }], eta: '2026-11-05T12:00:00Z', pricePerGal: 2.97 }

describe('mock DTL vendor', () => {
  it('creates once per idempotency key and replays the same order', async () => {
    const { app, settings } = createVendorApp({ postTicket: async () => undefined })
    settings.latencyMs = 0
    const a = await request(app).post('/vendor/v1/orders').set('Idempotency-Key', 'k1').send(body)
    const b = await request(app).post('/vendor/v1/orders').set('Idempotency-Key', 'k1').send(body)
    expect(a.status).toBe(201)
    expect(b.status).toBe(200)
    expect(b.body.id).toBe(a.body.id)
    expect((await request(app).get('/vendor/v1/orders').query({ idempotencyKey: 'k1' })).body.id).toBe(a.body.id)
  })

  it('creates the order even when the response is lost (timeout mode)', async () => {
    const { app, settings, orders } = createVendorApp({ postTicket: async () => undefined })
    Object.assign(settings, { latencyMs: 0, timeoutNext: 1, hangMs: 50 })
    await request(app).post('/vendor/v1/orders').set('Idempotency-Key', 'k2').send(body)
    expect(orders.size).toBe(1)
    expect(settings.timeoutNext).toBe(0)
  })

  it('bills the ticket but short-fills the tank when configured', async () => {
    const tickets: Record<string, unknown>[] = []
    const { app, settings } = createVendorApp({ postTicket: async (t) => void tickets.push(t) })
    Object.assign(settings, { latencyMs: 0, shortFillPct: 15 })
    const created = await request(app).post('/vendor/v1/orders').set('Idempotency-Key', 'k3').send(body)
    const delivered = await request(app).post(`/vendor/v1/orders/${created.body.id}/deliver`).send({ perUnit: [{ locomotiveId: '6012', gallons: 2000 }], deliveredAt: '2026-11-05T12:00:00Z' })
    expect(delivered.body.actual[0].gallons).toBe(1700)
    expect((tickets[0].perUnit as { gallons: number }[])[0].gallons).toBe(2000)
  })

  it('refuses delivery for a cancelled order (no truck)', async () => {
    const { app, settings } = createVendorApp({ postTicket: async () => undefined })
    settings.latencyMs = 0
    const created = await request(app).post('/vendor/v1/orders').set('Idempotency-Key', 'k4').send(body)
    await request(app).post(`/vendor/v1/orders/${created.body.id}/cancel`)
    const res = await request(app).post(`/vendor/v1/orders/${created.body.id}/deliver`).send({ perUnit: [], deliveredAt: '2026-11-05T12:00:00Z' })
    expect(res.status).toBe(409)
  })
})
