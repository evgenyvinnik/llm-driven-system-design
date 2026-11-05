/**
 * Re-plan triggers. Anything that should make the planner look again (burn
 * deviation, station passage, price change, reroute, vendor refusal, fueling)
 * enqueues a request here. A short per-train "pending" key coalesces bursts:
 * ten triggers in five seconds become one planner run, and the run reads the
 * newest inputs anyway.
 * @module shared/triggers
 */
import { config } from './config.js'
import { keys, redis } from './cache.js'
import { planTriggers } from './metrics.js'

export type PlanTrigger =
  | 'initial'
  | 'checkpoint'
  | 'burn_deviation'
  | 'leak_suspected'
  | 'price_change'
  | 'reroute'
  | 'order_rejected'
  | 'order_failed'
  | 'fueled'
  | 'param_change'
  | 'manual'
  | 'periodic'

export async function enqueuePlan(trainId: string, trigger: PlanTrigger, detail = ''): Promise<boolean> {
  // Manual and safety triggers bypass coalescing: the person pressing the button expects a run.
  const bypass = trigger === 'manual' || trigger === 'reroute'
  if (!bypass) {
    const fresh = await redis.set(keys.planPending(trainId), trigger, 'EX', config.planner.coalesceSeconds, 'NX')
    if (!fresh) {
      planTriggers.inc({ trigger, coalesced: 'yes' })
      return false
    }
  }
  await redis.xadd(keys.planRequests, 'MAXLEN', '~', '10000', '*', 'trainId', trainId, 'trigger', trigger, 'detail', detail.slice(0, 300))
  planTriggers.inc({ trigger, coalesced: 'no' })
  return true
}
