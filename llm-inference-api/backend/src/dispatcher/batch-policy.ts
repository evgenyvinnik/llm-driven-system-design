/**
 * When a priority class dispatches a batch. Three triggers:
 * - full:     at least batchMaxSize requests are queued and that many slots are free;
 * - max_wait: the oldest queued request has waited maxWaitMs (low traffic: a
 *             batch that never fills still leaves, so no request waits longer);
 * - deadline: some request's deadline is within deadlineSlackMs.
 * The batch never exceeds free slots: with no capacity, nothing is dispatched
 * and the bounded queue (plus admission's 529) absorbs the backlog.
 * @module dispatcher/batch-policy
 */

export type BatchTrigger = 'full' | 'max_wait' | 'deadline'

export interface ClassQueueState {
  depth: number
  oldestEnqueuedAt: number | null
  earliestDeadline: number | null
}

export interface BatchPolicyConfig {
  batchMaxSize: number
  maxWaitMs: number
  deadlineSlackMs: number
}

export interface DispatchDecision {
  trigger: BatchTrigger
  size: number
  oldestWaitMs: number
}

export function decideDispatch(q: ClassQueueState, freeSlots: number, cfg: BatchPolicyConfig, now: number): DispatchDecision | null {
  if (q.depth <= 0 || freeSlots <= 0 || q.oldestEnqueuedAt === null) return null
  const oldestWaitMs = Math.max(0, now - q.oldestEnqueuedAt)
  const max = Math.max(1, cfg.batchMaxSize)
  if (q.depth >= max && freeSlots >= max) return { trigger: 'full', size: max, oldestWaitMs }
  const size = Math.min(q.depth, freeSlots, max)
  if (oldestWaitMs >= cfg.maxWaitMs) return { trigger: 'max_wait', size, oldestWaitMs }
  if (q.earliestDeadline !== null && q.earliestDeadline - now <= cfg.deadlineSlackMs) return { trigger: 'deadline', size, oldestWaitMs }
  return null
}

/**
 * Slots each class may use now.
 * - Bulk has a guaranteed share (batchMinShare): while below it with work
 *   queued, those slots are held back from interactive traffic, so bulk is
 *   never starved.
 * - Bulk also has a ceiling (batchMaxShare): even with no interactive work
 *   waiting it never holds more, so an interactive burst finds free slots
 *   instead of queueing behind long bulk generations.
 * - Between the two, bulk gets slots only when no interactive work waits.
 */
export function classCapacity(
  free: number,
  totalSlots: number,
  batchInFlight: number,
  interactiveWaiting: boolean,
  batchWaiting: boolean,
  batchMinShare: number,
  batchMaxShare = 1,
): { interactive: number; batch: number } {
  const guaranteed = Math.max(1, Math.floor(totalSlots * batchMinShare))
  const ceiling = Math.max(guaranteed, Math.floor(totalSlots * batchMaxShare))
  const owed = Math.max(0, guaranteed - batchInFlight)
  const reserve = batchWaiting ? Math.min(free, owed) : 0
  const headroom = Math.max(0, ceiling - batchInFlight)
  return {
    interactive: Math.max(0, free - reserve),
    batch: Math.min(free, interactiveWaiting ? owed : headroom),
  }
}
