/**
 * Consumer group `replanner`: feeds the process manager.
 *   ConnectionMissed → start a saga (deduplicated per trip, plan version, leg and attempt)
 *   EtaUpdated       → complete the saga waiting on that revision's ETA
 *   TrainCancelled   → compensate sagas that chose the train; start sagas for cars planned on it
 * The saga's own steps run after the message's transaction commits (and again from the sweeper).
 * @module replanner/handler
 */
import type { AnyEnvelope } from '../shared/events/envelope.js'
import type { EventType } from '../shared/events/schemas.js'
import type { HandlerContext } from '../shared/consumer.js'
import { advance, onEtaUpdated, onTrainCancelled, startSaga } from './saga.js'

export const REPLANNER_TYPES: EventType[] = ['ConnectionMissed', 'EtaUpdated', 'TrainCancelled']

export async function handleReplanner(e: AnyEnvelope, ctx: HandlerContext): Promise<void> {
  const { tx } = ctx
  if (e.type === 'ConnectionMissed') {
    const p = e.payload
    const sagaId = await startSaga(tx, {
      tripId: p.tripId, carId: p.carId, shipperId: p.shipperId, trigger: p.reason, cause: e, fromPlanVersion: p.planVersion, legSeq: p.legSeq,
      yardId: p.yardId, missedRunId: p.runId, readyAt: p.availableAt,
    })
    if (sagaId) ctx.afterCommit(() => advance(sagaId))
  } else if (e.type === 'EtaUpdated') {
    await onEtaUpdated(tx, e)
  } else if (e.type === 'TrainCancelled') {
    const ids = await onTrainCancelled(tx, e)
    ctx.afterCommit(async () => {
      for (const id of ids) await advance(id)
    })
  }
}
