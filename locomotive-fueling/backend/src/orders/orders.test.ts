import { describe, expect, it } from 'vitest'
import { advance, backoffMs, type CancelResult, type CreateResult, type LookupResult, type OrderForVendor, type VendorClient } from './state-machine.js'
import { withinTolerance } from './tolerance.js'

/** An in-memory vendor that is idempotent on key and can be told to lose responses. */
class FakeVendor implements VendorClient {
  orders = new Map<string, { id: string; status: string }>()
  creates = 0
  loseNextResponse = false
  refuseNext = false
  downForLookups = false

  async create(order: OrderForVendor): Promise<CreateResult> {
    this.creates++
    if (this.refuseNext) {
      this.refuseNext = false
      return { kind: 'rejected', message: 'no truck' }
    }
    const existing = this.orders.get(order.stopKey)
    const created = existing ?? { id: `V${this.orders.size + 1}`, status: 'confirmed' }
    this.orders.set(order.stopKey, created)
    if (this.loseNextResponse) {
      this.loseNextResponse = false
      return { kind: 'unknown', message: 'timeout' }
    }
    return { kind: 'created', vendorOrderId: created.id, replayed: Boolean(existing) }
  }
  async lookup(key: string): Promise<LookupResult> {
    if (this.downForLookups) return { kind: 'error', message: 'HTTP 503' }
    const o = this.orders.get(key)
    return o ? { kind: 'found', vendorOrderId: o.id, status: o.status } : { kind: 'not_found' }
  }
  async cancel(id: string): Promise<CancelResult> {
    const o = [...this.orders.values()].find((x) => x.id === id)
    if (!o) return { kind: 'not_found' }
    o.status = 'cancelled'
    return { kind: 'cancelled', fee: 150 }
  }
}

const HOUR = 3_600_000
const ctx = { nowSimMs: 0, maxAttempts: 4 }

function order(extra: Partial<OrderForVendor> = {}): OrderForVendor {
  return {
    id: '1', stopKey: 'T01:GAL:GAL-DTL', status: 'pending', attempts: 1, vendorOrderId: null, trainId: 'T01', locationId: 'GAL', optionId: 'GAL-DTL',
    gallonsRequested: 4000, perUnit: [], etaMs: 10 * HOUR, pricePerGal: 2.97, leadTimeHours: 6, ...extra,
  }
}

describe('idempotent DTL ordering', () => {
  it('confirms on a clean create', async () => {
    const vendor = new FakeVendor()
    const t = await advance(order(), vendor, ctx)
    expect(t).toMatchObject({ to: 'confirmed', vendorOrderId: 'V1' })
  })

  it('treats a timeout as unknown, then finds the order by key instead of creating a second one', async () => {
    const vendor = new FakeVendor()
    vendor.loseNextResponse = true
    const first = await advance(order(), vendor, ctx)
    expect(first.to).toBe('unknown')
    expect(first.retryInMs).toBe(backoffMs(1))
    const second = await advance(order({ status: 'unknown', attempts: 2 }), vendor, ctx)
    expect(second).toMatchObject({ to: 'confirmed', vendorOrderId: 'V1' })
    expect(vendor.orders.size).toBe(1)
    expect(vendor.creates).toBe(1)
  })

  it('resubmits with the same key when the lookup finds nothing (the request never arrived)', async () => {
    const vendor = new FakeVendor()
    const t = await advance(order({ status: 'unknown', attempts: 2 }), vendor, ctx)
    expect(t.to).toBe('confirmed')
    expect(vendor.creates).toBe(1)
  })

  it('stays unknown while lookups fail, then gives up and asks for a re-plan', async () => {
    const vendor = new FakeVendor()
    vendor.downForLookups = true
    expect((await advance(order({ status: 'unknown', attempts: 2 }), vendor, ctx)).to).toBe('unknown')
    const last = await advance(order({ status: 'unknown', attempts: 4 }), vendor, ctx)
    expect(last).toMatchObject({ to: 'failed', replan: 'order_failed' })
    expect(last.alert?.type).toBe('order_failed')
  })

  it('gives up early when the train is too close to arrange a truck', async () => {
    const vendor = new FakeVendor()
    vendor.downForLookups = true
    const t = await advance(order({ status: 'unknown', attempts: 2, etaMs: 1 * HOUR }), vendor, ctx)
    expect(t.to).toBe('failed')
  })

  it('marks a refusal rejected and asks for a re-plan', async () => {
    const vendor = new FakeVendor()
    vendor.refuseNext = true
    expect(await advance(order(), vendor, ctx)).toMatchObject({ to: 'rejected', replan: 'order_rejected' })
  })

  it('cancels an order whose id we never learned by looking it up first', async () => {
    const vendor = new FakeVendor()
    vendor.loseNextResponse = true
    await advance(order(), vendor, ctx)
    const t = await advance(order({ status: 'cancel_requested', attempts: 2 }), vendor, ctx)
    expect(t).toMatchObject({ to: 'cancelled', vendorOrderId: 'V1', cancelFee: 150 })
    expect(vendor.orders.get('T01:GAL:GAL-DTL')?.status).toBe('cancelled')
  })

  it('cancels for free when the vendor never received the order', async () => {
    const t = await advance(order({ status: 'cancel_requested', attempts: 2 }), new FakeVendor(), ctx)
    expect(t).toMatchObject({ to: 'cancelled', cancelFee: 0 })
  })
})

describe('ticket tolerance', () => {
  it('accepts small differences and flags short fills', () => {
    expect(withinTolerance(4000, 3900)).toBe(true)
    expect(withinTolerance(4000, 3400)).toBe(false)
    expect(withinTolerance(1000, 880)).toBe(true)
  })
})
