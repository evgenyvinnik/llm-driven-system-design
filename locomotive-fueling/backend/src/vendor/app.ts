/**
 * Mock DTL (direct-to-locomotive) fuel vendor. Behaves like a real partner API
 * with real failure modes, switchable at runtime:
 * - latency on every call,
 * - armed one-shot faults: the next N creates fail with 500 (nothing created),
 *   time out (order IS created, response never comes: the unknown-outcome
 *   case), or are refused with 409 (no truck available),
 * - a short-fill percentage: the truck delivers less than the ticket bills.
 * Creates are idempotent on the Idempotency-Key header, like most payment and
 * logistics APIs. Delivery is triggered by the simulator when the train is on
 * site; the vendor then posts a fuel ticket to our webhook, with retries.
 * Orders live in memory; a restart forgets them (lookup then says not found).
 * @module vendor/app
 */
import express, { type Request, type Response } from 'express'
import { z } from 'zod'
import { config } from '../shared/config.js'
import { logger } from '../shared/logger.js'
import { metricsHandler } from '../shared/metrics.js'

export interface VendorSettings {
  latencyMs: number
  failNext: number
  timeoutNext: number
  rejectNext: number
  /** How long a "timeout" response hangs before replying (longer than the client waits). */
  hangMs: number
  shortFillPct: number
  cancelFee: number
}

export interface VendorOrder {
  id: string
  idempotencyKey: string
  status: 'confirmed' | 'cancelled' | 'delivered'
  trainId: string
  locationId: string
  optionId: string
  gallons: number
  perUnit: { locomotiveId: string; gallons: number }[]
  eta: string
  pricePerGal: number
  createdAt: string
  ticketId?: string
}

const createSchema = z.object({
  trainId: z.string(),
  locationId: z.string(),
  optionId: z.string(),
  gallons: z.number().positive(),
  perUnit: z.array(z.object({ locomotiveId: z.string(), gallons: z.number() }).passthrough()),
  eta: z.string(),
  pricePerGal: z.number().positive(),
})

const deliverSchema = z.object({
  perUnit: z.array(z.object({ locomotiveId: z.string(), gallons: z.number().nonnegative() })),
  deliveredAt: z.string(),
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function createVendorApp(opts: { postTicket?: (ticket: Record<string, unknown>) => Promise<void> } = {}) {
  const settings: VendorSettings = { latencyMs: 150, failNext: 0, timeoutNext: 0, rejectNext: 0, hangMs: 8000, shortFillPct: 0, cancelFee: 150 }
  const orders = new Map<string, VendorOrder>()
  const byKey = new Map<string, string>()
  let seq = 1000

  const app = express()
  app.disable('x-powered-by')
  app.use(express.json())
  app.get('/health', (_req, res) => res.json({ status: 'ok' }))
  app.get('/metrics', (req, res) => void metricsHandler(req, res))

  app.post('/vendor/v1/orders', async (req: Request, res: Response) => {
    await sleep(settings.latencyMs)
    const key = req.get('Idempotency-Key')
    if (!key) return res.status(400).json({ error: { message: 'Idempotency-Key header required' } })
    const existing = byKey.get(key)
    if (existing) return res.status(200).json({ ...orders.get(existing), replayed: true })
    if (settings.rejectNext > 0) {
      settings.rejectNext--
      return res.status(409).json({ error: { message: 'No truck available for that window' } })
    }
    if (settings.failNext > 0) {
      settings.failNext--
      return res.status(500).json({ error: { message: 'Internal error' } })
    }
    const parsed = createSchema.safeParse(req.body)
    if (!parsed.success) return res.status(422).json({ error: { message: 'Invalid order', details: parsed.error.issues } })
    const order: VendorOrder = { id: `DTL-${++seq}`, idempotencyKey: key, status: 'confirmed', ...parsed.data, createdAt: new Date().toISOString() }
    orders.set(order.id, order)
    byKey.set(key, order.id)
    logger.info({ id: order.id, key }, 'vendor order created')
    if (settings.timeoutNext > 0) {
      // The order exists, but the caller never hears back.
      settings.timeoutNext--
      await sleep(settings.hangMs)
    }
    return res.status(201).json(order)
  })

  app.get('/vendor/v1/orders', async (req, res) => {
    await sleep(settings.latencyMs)
    const key = String(req.query.idempotencyKey ?? '')
    if (!key) return res.json({ orders: [...orders.values()].slice(-100).reverse() })
    const id = byKey.get(key)
    return id ? res.json(orders.get(id)) : res.status(404).json({ error: { message: 'No order with that key' } })
  })

  app.get('/vendor/v1/orders/:id', (req, res) => {
    const order = orders.get(req.params.id)
    return order ? res.json(order) : res.status(404).json({ error: { message: 'Not found' } })
  })

  app.post('/vendor/v1/orders/:id/cancel', async (req, res) => {
    await sleep(settings.latencyMs)
    const order = orders.get(req.params.id)
    if (!order) return res.status(404).json({ error: { message: 'Not found' } })
    if (order.status === 'delivered') return res.status(409).json({ error: { message: 'Already delivered' } })
    const fee = order.status === 'cancelled' ? 0 : settings.cancelFee
    order.status = 'cancelled'
    return res.json({ ...order, cancelFee: fee })
  })

  /** The truck is on site. Called by the simulator; returns what actually went into each tank. */
  app.post('/vendor/v1/orders/:id/deliver', async (req, res) => {
    const order = orders.get(req.params.id)
    if (!order || order.status !== 'confirmed') return res.status(409).json({ error: { message: 'No confirmed order: truck not dispatched' } })
    const body = deliverSchema.parse(req.body)
    const billed = body.perUnit.map((u) => ({ locomotiveId: u.locomotiveId, gallons: Math.round(u.gallons) }))
    const actual = billed.map((u) => ({ ...u, gallons: Math.round(u.gallons * (1 - settings.shortFillPct / 100)) }))
    order.status = 'delivered'
    order.ticketId = `VT-${order.id}`
    const ticket = {
      ticketId: order.ticketId,
      source: 'vendor',
      vendorOrderId: order.id,
      stopKey: order.idempotencyKey,
      trainId: order.trainId,
      locationId: order.locationId,
      optionId: order.optionId,
      deliveredAt: body.deliveredAt,
      pricePerGal: order.pricePerGal,
      perUnit: billed,
    }
    void (opts.postTicket ?? postTicketWithRetry)(ticket)
    return res.json({ ticketId: order.ticketId, actual })
  })

  app.get('/vendor/v1/admin/settings', (_req, res) => res.json(settings))
  app.put('/vendor/v1/admin/settings', (req, res) => {
    const patch = z
      .object({
        latencyMs: z.number().int().min(0).max(20000),
        failNext: z.number().int().min(0).max(20),
        timeoutNext: z.number().int().min(0).max(20),
        rejectNext: z.number().int().min(0).max(20),
        hangMs: z.number().int().min(0).max(60000),
        shortFillPct: z.number().min(0).max(50),
        cancelFee: z.number().min(0),
      })
      .partial()
      .parse(req.body)
    Object.assign(settings, patch)
    res.json(settings)
  })

  return { app, settings, orders }
}

/** Webhook delivery with retries. The ticket id makes redelivery harmless on our side. */
async function postTicketWithRetry(ticket: Record<string, unknown>): Promise<void> {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(`${config.apiUrl}/api/v1/integrations/fuel-tickets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Integration-Token': config.integrationToken },
        body: JSON.stringify(ticket),
        signal: AbortSignal.timeout(5000),
      })
      if (res.ok) return
      logger.warn({ status: res.status, ticket: ticket.ticketId }, 'ticket webhook rejected')
      if (res.status < 500) return
    } catch (err) {
      logger.warn({ err: (err as Error).message, attempt }, 'ticket webhook failed')
    }
    await sleep(1000 * 2 ** attempt)
  }
}
