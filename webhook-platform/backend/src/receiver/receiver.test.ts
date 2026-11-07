import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { signatureHeader } from '../delivery/signing.js'
import { createReceiverApp } from './app.js'
import { ReceiverState } from './state.js'

const SECRET = 'whsec_test'
const token = 'tok'

function setup() {
  const state = new ReceiverState()
  const app = createReceiverApp(state, async () => [SECRET], { token, toleranceSeconds: 300 })
  return { state, app }
}

function delivery(app: ReturnType<typeof setup>['app'], body: object, opts: { secret?: string; t?: number; attempt?: number } = {}) {
  const raw = JSON.stringify(body)
  const t = opts.t ?? Math.floor(Date.now() / 1000)
  return request(app)
    .post('/hooks/orders')
    .set('content-type', 'application/json')
    .set('webhook-id', (body as { id: string }).id)
    .set('webhook-attempt', String(opts.attempt ?? 1))
    .set('webhook-signature', signatureHeader([opts.secret ?? SECRET], t, raw))
    .send(raw)
}

describe('mock receiver', () => {
  it('accepts a signed delivery and flags the second copy of the same event id as a duplicate (still 200)', async () => {
    const { app, state } = setup()
    const ev = { id: 'evt_1', type: 'order.created', data: {} }
    expect((await delivery(app, ev)).status).toBe(200)
    const again = await delivery(app, ev, { attempt: 2 })
    expect(again.status).toBe(200)
    expect(again.body).toMatchObject({ duplicate: true })
    expect(state.stats(null)).toMatchObject({ processed: 2, uniqueEvents: 1, duplicates: 1 })
  })

  it('rejects forged and stale signatures with 401', async () => {
    const { app } = setup()
    const forged = await delivery(app, { id: 'evt_2', type: 'order.created' }, { secret: 'whsec_wrong' })
    expect(forged.status).toBe(401)
    expect(forged.body.reason).toBe('no_matching_signature')
    const stale = await delivery(app, { id: 'evt_3', type: 'order.created' }, { t: Math.floor(Date.now() / 1000) - 3600 })
    expect(stale.status).toBe(401)
    expect(stale.body.reason).toBe('timestamp_outside_tolerance')
  })

  it('arms faults for N requests, then recovers', async () => {
    const { app, state } = setup()
    state.update('orders', { mode: 'error500', remaining: 2 })
    expect((await delivery(app, { id: 'evt_4', type: 'x.y' })).status).toBe(500)
    expect((await delivery(app, { id: 'evt_4', type: 'x.y' })).status).toBe(500)
    expect((await delivery(app, { id: 'evt_4', type: 'x.y' })).status).toBe(200)
    state.update('orders', { mode: 'rate429', remaining: 1, retryAfterSeconds: 7 })
    const limited = await delivery(app, { id: 'evt_5', type: 'x.y' })
    expect(limited.status).toBe(429)
    expect(limited.headers['retry-after']).toBe('7')
    state.update('orders', { mode: 'gone410' })
    expect((await delivery(app, { id: 'evt_6', type: 'x.y' })).status).toBe(410)
  })

  it('drop_ack processes the event and then closes the socket without answering', async () => {
    const { app, state } = setup()
    state.update('orders', { mode: 'drop_ack', remaining: 1 })
    await expect(delivery(app, { id: 'evt_7', type: 'x.y' })).rejects.toThrow()
    expect(state.received(null, 1)[0]).toMatchObject({ eventId: 'evt_7', processed: true, responseStatus: null })
    const retry = await delivery(app, { id: 'evt_7', type: 'x.y' }, { attempt: 2 })
    expect(retry.body).toMatchObject({ duplicate: true })
  })

  it('discards an older sequence for the same ordering key as stale', async () => {
    const { app } = setup()
    await delivery(app, { id: 'evt_a', type: 'order.updated', ordering_key: 'order_1', sequence: 2 })
    const older = await delivery(app, { id: 'evt_b', type: 'order.updated', ordering_key: 'order_1', sequence: 1 })
    expect(older.body).toMatchObject({ stale: true, duplicate: false })
  })

  it('protects the control API with the internal token', async () => {
    const { app } = setup()
    expect((await request(app).get('/_control/paths')).status).toBe(401)
    const ok = await request(app).put('/_control/paths/orders').set('x-internal-token', token).send({ mode: 'slow', slowMs: 10 })
    expect(ok.body.path).toMatchObject({ mode: 'slow', slowMs: 10 })
  })
})
