/**
 * Scripted walkthrough: drives the real pipeline (API → outbox → RabbitMQ →
 * workers → mock receiver) into every state worth looking at, so the console
 * has something to show. Run with the whole stack up:
 *
 *   npm run demo:story
 *
 * What it leaves behind:
 * - normal deliveries for both orgs, with per-key sequence numbers;
 * - a dropped acknowledgment: the receiver processed the event, the platform
 *   retried, the receiver flagged the duplicate;
 * - 500, 500, 500, then success, with jittered backoff between attempts;
 * - a 429 whose Retry-After was honoured;
 * - a 410 that disabled globex-crm immediately, then re-enable + replay;
 * - acme-audit failing until its retry window ran out: disabled + notification;
 * - a secret rotation in progress on acme-orders (two signatures per request).
 */
import { call, emit, login, sleep, waitFor } from './client.js'

const log = (msg: string) => console.log(`• ${msg}`)

const alice = await login('alice')
const bob = await login('bob')
const admin = await login('admin')
const policy = (await call('GET', '/ops/overview', { cookie: admin })).policy as { retryHorizonSeconds: number }

const setPath = (cookie: string, name: string, body: Record<string, unknown>) => call('PUT', `/receiver/paths/${name}`, { cookie, body })
const delivery = async (cookie: string, eventId: string, endpointId: string) => {
  const ev = await call('GET', `/events/${eventId}`, { cookie })
  return (ev.deliveries as { id: string; endpointId: string; state: string; attemptCount: number }[]).find((d) => d.endpointId === endpointId)
}
const until = (cookie: string, eventId: string, endpointId: string, states: string[], ms: number) =>
  waitFor(async () => {
    const d = await delivery(cookie, eventId, endpointId)
    return d && states.includes(d.state) ? d : null
  }, ms)

log('Resetting receiver toggles and re-enabling endpoints')
for (const [cookie, paths] of [[alice, ['acme-orders', 'acme-billing', 'acme-audit']], [bob, ['globex-main', 'globex-crm']]] as const) {
  for (const p of paths) await setPath(cookie, p, { mode: 'ok' })
}
for (const [cookie, ids] of [[alice, ['ep_acme_orders', 'ep_acme_billing', 'ep_acme_audit']], [bob, ['ep_globex_main', 'ep_globex_crm']]] as const) {
  for (const id of ids) await call('POST', `/endpoints/${id}/enable`, { cookie })
}

log('Normal traffic: orders with ordering keys, invoices, customers')
for (let i = 1; i <= 3; i++) {
  await emit('acme', 'order.created', { orderId: `10${i}`, amount: 1200 * i }, `order_10${i}`)
  await emit('acme', 'order.updated', { orderId: `10${i}`, status: 'paid' }, `order_10${i}`)
  await emit('globex', 'customer.updated', { customerId: `c_${i}`, plan: 'pro' })
}
await emit('acme', 'invoice.paid', { invoiceId: 'in_2001', amount: 9900 })
await emit('globex', 'order.created', { orderId: 'g_501', amount: 300 })
await sleep(1500)

log('acme-billing answers 500 three times, then recovers')
await setPath(alice, 'acme-billing', { mode: 'error500', remaining: 3 })
const retry = await emit('acme', 'invoice.failed', { invoiceId: 'in_2002', amount: 4500 })
await until(alice, retry.event.id, 'ep_acme_billing', ['delivered'], 60_000)

log('globex-crm rate-limits once with Retry-After: 3')
await setPath(bob, 'globex-crm', { mode: 'rate429', remaining: 1, retryAfterSeconds: 3 })
const limited = await emit('globex', 'customer.updated', { customerId: 'c_9', plan: 'enterprise' })
await until(bob, limited.event.id, 'ep_globex_crm', ['delivered'], 30_000)

log('globex-crm answers 410 Gone: stop at once, disable, notify')
await setPath(bob, 'globex-crm', { mode: 'gone410', remaining: 1 })
const gone = await emit('globex', 'customer.updated', { customerId: 'c_10', plan: 'free' })
const goneDelivery = await until(bob, gone.event.id, 'ep_globex_crm', ['failed'], 20_000)
await sleep(500)
log('Bob fixes the receiver, re-enables globex-crm and replays that delivery (same event id)')
await call('POST', '/endpoints/ep_globex_crm/enable', { cookie: bob })
if (goneDelivery) await call('POST', `/deliveries/${goneDelivery.id}/replay`, { cookie: bob })

log(`acme-audit goes down (500) until its ${policy.retryHorizonSeconds}s retry window runs out`)
await setPath(alice, 'acme-audit', { mode: 'error500' })
const doomed = await emit('acme', 'invoice.paid', { invoiceId: 'in_2003', amount: 15000 })
await emit('acme', 'order.created', { orderId: '104', amount: 800 }, 'order_104')
const disabled = await waitFor(async () => {
  const ep = await call('GET', '/endpoints/ep_acme_audit', { cookie: alice })
  return ep.endpoint.status === 'disabled' ? ep.endpoint : null
}, (policy.retryHorizonSeconds + 60) * 1000, 2000)
log(disabled ? `acme-audit disabled (${disabled.disabledReason}); Alice has a notification` : 'acme-audit still retrying (horizon not reached yet)')
await setPath(alice, 'acme-audit', { mode: 'ok' })

log('Rotating the acme-orders secret with a 10-minute overlap (both signatures sent)')
await call('POST', '/endpoints/ep_acme_orders/rotate-secret', { cookie: alice, body: { overlapSeconds: 600 } })
await emit('acme', 'order.updated', { orderId: '103', status: 'shipped' }, 'order_103')

log('Dropped acknowledgment on acme-orders: processed, ack lost, retried, duplicate detected')
await setPath(alice, 'acme-orders', { mode: 'drop_ack', remaining: 1 })
const drop = await emit('acme', 'order.cancelled', { orderId: '102', reason: 'customer request' }, 'order_102')
await until(alice, drop.event.id, 'ep_acme_orders', ['delivered'], 20_000)

const d = await delivery(alice, doomed.event.id, 'ep_acme_audit')
log(`Done. Look at: /endpoints/ep_acme_audit (disabled, failed deliveries), /deliveries/${d?.id ?? '…'} (attempt timeline), /receiver (duplicates), /notifications`)
