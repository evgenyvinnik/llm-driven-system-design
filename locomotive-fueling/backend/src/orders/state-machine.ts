/**
 * DTL order state machine. Pure apart from the vendor client it is handed, so
 * the unknown-outcome paths are unit-tested with a fake vendor.
 *
 *   pending ──create ok──▶ confirmed ──ticket──▶ delivered ──match──▶ reconciled | discrepancy
 *      │ refused ─────────▶ rejected (re-plan without this option)
 *      │ timeout / 5xx ───▶ unknown ──lookup finds it──▶ confirmed
 *      │                       │ lookup: not found ──▶ create again, same key
 *      │                       │ out of attempts / too late ──▶ failed (re-plan, alert)
 *   cancel_requested ──lookup/cancel──▶ cancelled
 *
 * The rule that makes this safe: after a timeout we never assume the order
 * failed. We ask the vendor by idempotency key before trying again. That works
 * even against a vendor that is not idempotent itself.
 * @module orders/state-machine
 */

export type OrderStatus =
  | 'pending'
  | 'unknown'
  | 'confirmed'
  | 'rejected'
  | 'failed'
  | 'cancel_requested'
  | 'cancelled'
  | 'delivered'
  | 'reconciled'
  | 'discrepancy'

export interface OrderForVendor {
  id: string
  stopKey: string
  status: OrderStatus
  attempts: number
  vendorOrderId: string | null
  trainId: string
  locationId: string
  optionId: string
  gallonsRequested: number
  perUnit: { locomotiveId: string; gallons: number }[]
  etaMs: number
  pricePerGal: number
  leadTimeHours: number
}

export type CreateResult =
  | { kind: 'created'; vendorOrderId: string; replayed: boolean }
  | { kind: 'rejected'; message: string }
  | { kind: 'unknown'; message: string }

export type LookupResult = { kind: 'found'; vendorOrderId: string; status: string } | { kind: 'not_found' } | { kind: 'error'; message: string }

export type CancelResult = { kind: 'cancelled'; fee: number } | { kind: 'not_found' } | { kind: 'too_late'; message: string } | { kind: 'error'; message: string }

export interface VendorClient {
  create(order: OrderForVendor): Promise<CreateResult>
  lookup(idempotencyKey: string): Promise<LookupResult>
  cancel(vendorOrderId: string): Promise<CancelResult>
}

export interface Transition {
  to: OrderStatus
  note: string
  vendorOrderId?: string
  error?: string
  /** Wall-clock delay before the next attempt, for states that keep working. */
  retryInMs?: number
  cancelFee?: number
  alert?: { type: 'order_rejected' | 'order_failed' | 'order_unknown'; message: string }
  replan?: 'order_rejected' | 'order_failed'
}

export interface AdvanceContext {
  nowSimMs: number
  maxAttempts: number
}

export const backoffMs = (attempts: number) => Math.min(30_000, 1000 * 2 ** Math.max(0, attempts - 1))

async function submit(order: OrderForVendor, vendor: VendorClient, ctx: AdvanceContext, via: string): Promise<Transition> {
  const res = await vendor.create(order)
  if (res.kind === 'created') {
    return { to: 'confirmed', vendorOrderId: res.vendorOrderId, note: `${via}: vendor confirmed ${res.vendorOrderId}${res.replayed ? ' (replayed by idempotency key)' : ''}` }
  }
  if (res.kind === 'rejected') {
    return {
      to: 'rejected',
      error: res.message,
      note: `Vendor refused: ${res.message}`,
      alert: { type: 'order_rejected', message: `DTL order ${order.stopKey} refused by vendor: ${res.message}` },
      replan: 'order_rejected',
    }
  }
  return giveUpOrWait(order, ctx, `${via}: outcome unknown (${res.message})`)
}

function giveUpOrWait(order: OrderForVendor, ctx: AdvanceContext, note: string): Transition {
  const hoursAway = (order.etaMs - ctx.nowSimMs) / 3_600_000
  const tooLate = hoursAway < Math.min(2, order.leadTimeHours)
  if (order.attempts >= ctx.maxAttempts || tooLate) {
    const why = tooLate ? `train is ${hoursAway.toFixed(1)} h out` : `${order.attempts} attempts`
    return {
      to: 'failed',
      error: note,
      note: `Gave up (${why}); fuel desk to confirm by phone`,
      alert: { type: 'order_failed', message: `DTL order ${order.stopKey} could not be confirmed (${why}). Call the vendor; the plan is being recomputed without it.` },
      replan: 'order_failed',
    }
  }
  return { to: 'unknown', error: note, note, retryInMs: backoffMs(order.attempts) }
}

/** One step for an order the worker has claimed (attempts already incremented). */
export async function advance(order: OrderForVendor, vendor: VendorClient, ctx: AdvanceContext): Promise<Transition> {
  switch (order.status) {
    case 'pending':
      return submit(order, vendor, ctx, 'Submitted')
    case 'unknown': {
      const found = await vendor.lookup(order.stopKey)
      if (found.kind === 'found') {
        if (found.status === 'cancelled') return { to: 'cancelled', vendorOrderId: found.vendorOrderId, note: 'Lookup: vendor shows the order cancelled' }
        return { to: 'confirmed', vendorOrderId: found.vendorOrderId, note: `Lookup: vendor has ${found.vendorOrderId}; the earlier request succeeded after we stopped waiting` }
      }
      if (found.kind === 'not_found') return submit(order, vendor, ctx, 'Lookup found nothing; resubmitted with the same key')
      return giveUpOrWait(order, ctx, `Lookup failed (${found.message})`)
    }
    case 'cancel_requested': {
      let vendorOrderId = order.vendorOrderId
      if (!vendorOrderId) {
        // We may never have learned the id (timeout). Ask by key before deciding nothing exists.
        const found = await vendor.lookup(order.stopKey)
        if (found.kind === 'not_found') return { to: 'cancelled', note: 'Nothing to cancel: vendor never received the order', cancelFee: 0 }
        if (found.kind === 'error') return { to: 'cancel_requested', error: found.message, note: `Cancel lookup failed (${found.message})`, retryInMs: backoffMs(order.attempts) }
        vendorOrderId = found.vendorOrderId
      }
      const res = await vendor.cancel(vendorOrderId)
      if (res.kind === 'cancelled') return { to: 'cancelled', vendorOrderId, cancelFee: res.fee, note: `Cancelled ${vendorOrderId} (fee $${res.fee})` }
      if (res.kind === 'not_found') return { to: 'cancelled', vendorOrderId, cancelFee: 0, note: 'Vendor has no such order; treated as cancelled' }
      if (res.kind === 'too_late') return { to: 'delivered', vendorOrderId, note: `Could not cancel: ${res.message}` }
      return { to: 'cancel_requested', vendorOrderId, error: res.message, note: `Cancel failed (${res.message}); will retry`, retryInMs: backoffMs(order.attempts) }
    }
    default:
      return { to: order.status, note: 'No vendor work for this status' }
  }
}
