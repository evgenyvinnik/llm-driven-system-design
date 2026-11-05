/**
 * HTTP client for the DTL vendor API. Every create carries the stop key as
 * the Idempotency-Key header, and every call has a hard timeout: a timeout is
 * reported as "unknown", never as failure.
 * @module orders/vendor-client
 */
import { config } from '../shared/config.js'
import { vendorCalls } from '../shared/metrics.js'
import type { CancelResult, CreateResult, LookupResult, OrderForVendor, VendorClient } from './state-machine.js'

async function call(op: string, path: string, init: RequestInit = {}): Promise<{ status: number; body: Record<string, unknown> } | { error: string }> {
  const end = vendorCalls.startTimer({ op })
  try {
    const res = await fetch(`${config.vendorUrl}${path}`, { ...init, signal: AbortSignal.timeout(config.orders.vendorTimeoutMs) })
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
    end({ outcome: String(res.status) })
    return { status: res.status, body }
  } catch (err) {
    const name = (err as Error).name
    const error = name === 'TimeoutError' || name === 'AbortError' ? `no response in ${config.orders.vendorTimeoutMs} ms` : (err as Error).message
    end({ outcome: name === 'TimeoutError' ? 'timeout' : 'network' })
    return { error }
  }
}

const message = (body: Record<string, unknown>, fallback: string) => String((body.error as { message?: string } | undefined)?.message ?? body.message ?? fallback)

export const httpVendor: VendorClient = {
  async create(order: OrderForVendor): Promise<CreateResult> {
    const res = await call('create', '/vendor/v1/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': order.stopKey },
      body: JSON.stringify({
        trainId: order.trainId,
        locationId: order.locationId,
        optionId: order.optionId,
        gallons: order.gallonsRequested,
        perUnit: order.perUnit,
        eta: new Date(order.etaMs).toISOString(),
        pricePerGal: order.pricePerGal,
      }),
    })
    if ('error' in res) return { kind: 'unknown', message: res.error }
    if (res.status === 200 || res.status === 201) return { kind: 'created', vendorOrderId: String(res.body.id), replayed: res.status === 200 }
    if (res.status >= 400 && res.status < 500) return { kind: 'rejected', message: message(res.body, `HTTP ${res.status}`) }
    return { kind: 'unknown', message: `HTTP ${res.status}` }
  },
  async lookup(key: string): Promise<LookupResult> {
    const res = await call('lookup', `/vendor/v1/orders?idempotencyKey=${encodeURIComponent(key)}`)
    if ('error' in res) return { kind: 'error', message: res.error }
    if (res.status === 404) return { kind: 'not_found' }
    if (res.status === 200) return { kind: 'found', vendorOrderId: String(res.body.id), status: String(res.body.status) }
    return { kind: 'error', message: `HTTP ${res.status}` }
  },
  async cancel(vendorOrderId: string): Promise<CancelResult> {
    const res = await call('cancel', `/vendor/v1/orders/${encodeURIComponent(vendorOrderId)}/cancel`, { method: 'POST' })
    if ('error' in res) return { kind: 'error', message: res.error }
    if (res.status === 200) return { kind: 'cancelled', fee: Number(res.body.cancelFee ?? 0) }
    if (res.status === 404) return { kind: 'not_found' }
    if (res.status === 409) return { kind: 'too_late', message: message(res.body, 'already delivered') }
    return { kind: 'error', message: `HTTP ${res.status}` }
  },
}
