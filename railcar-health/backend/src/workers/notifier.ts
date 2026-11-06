/**
 * Notifier (integration consumer). Hands each NotificationRequested to the
 * notification provider (simulated) and records NotificationDelivered on the
 * case stream. "Delivered" only means the provider accepted the message; the
 * acknowledgment deadline keeps running until a person acknowledges.
 *
 * NotificationDelivered is appended with expected version 'any': it is an
 * external fact that doesn't depend on the case's state, so it never needs to
 * win a race. Exactly-once comes from processed_events.
 * @module workers/notifier
 */
import type { Handler } from '../events/consumer.js'
import { streamIds } from '../events/catalog.js'
import { now } from '../shared/clock.js'

export const notifierHandler: Handler = async (event, { batch }) => {
  if (event.type !== 'NotificationRequested') return undefined
  const p = event.payload as { caseId: string; notificationId: string; channel: string; target: string }
  // A real provider call goes here (paging, the EHMS-style owner channel). It is idempotent on notificationId.
  batch.append(streamIds.case(p.caseId), 'any', {
    type: 'NotificationDelivered',
    occurredAt: now(),
    tags: event.tags,
    payload: { caseId: p.caseId, notificationId: p.notificationId, channel: p.channel, target: p.target, provider: 'simulated' },
  })
  return undefined
}
