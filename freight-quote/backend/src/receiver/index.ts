/**
 * A mock customer webhook receiver: the customer's side of the callback.
 * It verifies the HMAC signature over the raw body, rejects stale
 * timestamps, and deduplicates by X-FQ-Event-Id (deliveries are at least
 * once). Knobs make it fail or slow down, to show retries from the sender.
 * @module receiver/index
 */
import express from 'express'
import { z } from 'zod'
import { config } from '../shared/config.js'
import { logger } from '../shared/logger.js'
import { verifySignature } from '../shared/signing.js'
import { webhookSecretFor } from '../shared/webhook-secrets.js'

interface Receipt {
  eventId: string
  customerId: string
  quoteId: string | null
  totalCents: number | null
  firstReceivedAt: string
  lastReceivedAt: string
  deliveries: number
  attempts: number[]
}

const inbox = new Map<string, Receipt>()
const rejected: { at: string; customerId: string; reason: string }[] = []
let knobs = { failNext: 0, latencyMs: 0 }

const app = express()

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'receiver' })
})

app.post('/hooks/:customerId', express.raw({ type: 'application/json', limit: '256kb' }), async (req, res) => {
  const customerId = req.params.customerId
  const body = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : ''
  const secret = webhookSecretFor(customerId)
  const check = verifySignature(secret, body, req.get('x-fq-signature'), Math.floor(Date.now() / 1000), config.webhooks.toleranceSeconds)
  if (!check.ok) {
    rejected.unshift({ at: new Date().toISOString(), customerId, reason: check.reason })
    rejected.splice(50)
    res.status(401).json({ error: `signature ${check.reason}` })
    return
  }
  if (knobs.latencyMs > 0) await new Promise((r) => setTimeout(r, knobs.latencyMs))
  if (knobs.failNext > 0) {
    knobs.failNext -= 1
    res.status(500).json({ error: 'injected receiver failure' })
    return
  }
  const eventId = req.get('x-fq-event-id') ?? 'missing'
  const attempt = Number(req.get('x-fq-delivery-attempt') ?? 0)
  const now = new Date().toISOString()
  const existing = inbox.get(eventId)
  if (existing) {
    // Duplicate delivery: acknowledge it again, but act on the event only once.
    existing.deliveries += 1
    existing.lastReceivedAt = now
    existing.attempts.push(attempt)
    res.json({ ok: true, duplicate: true })
    return
  }
  let quoteId: string | null = null
  let totalCents: number | null = null
  try {
    const parsed = JSON.parse(body) as { quote?: { id?: string; total_cents?: number } }
    quoteId = parsed.quote?.id ?? null
    totalCents = parsed.quote?.total_cents ?? null
  } catch {
    // keep the receipt even if the body is unexpected
  }
  inbox.set(eventId, { eventId, customerId, quoteId, totalCents, firstReceivedAt: now, lastReceivedAt: now, deliveries: 1, attempts: [attempt] })
  logger.info({ eventId, customerId, quoteId }, 'webhook received')
  res.json({ ok: true, duplicate: false })
})

app.get('/inbox', (_req, res) => {
  const receipts = [...inbox.values()].sort((a, b) => b.firstReceivedAt.localeCompare(a.firstReceivedAt)).slice(0, 100)
  res.json({ receipts, rejected, knobs })
})

app.put('/knobs', express.json(), (req, res) => {
  knobs = z.object({ failNext: z.number().int().min(0).max(100), latencyMs: z.number().int().min(0).max(30_000) }).parse({ ...knobs, ...req.body })
  res.json({ knobs })
})

app.listen(config.receiverPort, () => logger.info({ port: config.receiverPort }, 'mock customer webhook receiver listening'))
