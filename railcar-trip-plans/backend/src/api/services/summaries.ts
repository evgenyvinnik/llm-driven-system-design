/**
 * One-line, human-readable summaries of events for the timeline and causation views, and the shipper
 * redaction rule: a shipper sees a train's movement but not the other cars in its consist.
 * @module api/services/summaries
 */
import type { AnyEnvelope } from '../../shared/events/envelope.js'

const t = (iso: string) => `${iso.slice(5, 10)} ${iso.slice(11, 16)}Z`

export function summarize(e: AnyEnvelope, carId?: string): string {
  switch (e.type) {
    case 'CarSighted': {
      const p = e.payload
      const conf = p.readerConfidence === null ? 'no read confidence (v1 reader)' : `read confidence ${Math.round(p.readerConfidence * 100)}%`
      return `AEI read at ${p.siteId}${p.railroad !== 'PN' ? ` on ${p.railroad}` : ''}${p.trainRunId ? ` on ${p.trainRunId}` : ''}, ${conf}`
    }
    case 'CarArrivedYard':
      return `Arrived ${e.payload.yardId}${e.payload.trainRunId ? ` on ${e.payload.trainRunId}` : ''} (yard system)`
    case 'CarDepartedYard':
      return `Departed ${e.payload.yardId} on ${e.payload.trainRunId} (yard system)`
    case 'CarPlaced':
      return `Placed at customer ${e.payload.customerId}${e.payload.railroad !== 'PN' ? ` by ${e.payload.railroad}` : ''}`
    case 'CarPulled':
      return `Pulled from ${e.payload.customerId} into ${e.payload.yardId}`
    case 'CarBadOrdered':
      return `Bad-ordered at ${e.payload.yardId}: ${e.payload.defect}`
    case 'CarInterchanged': {
      const p = e.payload
      return p.direction === 'delivered' ? `Interchanged to ${p.toRoad} at ${p.interchangePoint}` : `Received from ${p.fromRoad} at ${p.interchangePoint}`
    }
    case 'TrainDeparted': {
      const p = e.payload
      const mine = carId ? (p.consist.includes(carId) ? ', this car aboard' : ', this car NOT aboard') : ''
      return `${p.runId} departed ${p.fromYard} with ${p.consist.length} cars${mine}`
    }
    case 'TrainArrived':
      return `${e.payload.runId} arrived ${e.payload.yardId}`
    case 'TrainDelayed':
      return `${e.payload.runId} delayed ${Math.round(e.payload.delayMinutes / 60)} h at ${e.payload.location}; new arrival ${t(e.payload.newEtaAt)} (${e.payload.reason})`
    case 'TrainCancelled':
      return `${e.payload.runId} cancelled: ${e.payload.reason}`
    case 'TripPlanCreated':
      return `Plan v1: ${e.payload.legs.map((l) => l.runId).join(' → ')}`
    case 'TripPlanRevised':
      return `Plan v${e.payload.version} (${e.payload.reason.code.replace(/_/g, ' ')}): ${e.payload.legs.map((l) => l.runId).join(' → ')}`
    case 'ConnectionMissed': {
      const p = e.payload
      return p.predicted
        ? `Will miss ${p.runId} at ${p.yardId}: inbound arrives too late (detected before departure)`
        : `Missed ${p.runId} at ${p.yardId}: train left without the car`
    }
    case 'EtaUpdated': {
      const p = e.payload
      const shift = p.shiftMinutes === null ? '' : ` (${p.shiftMinutes >= 0 ? '+' : ''}${Math.round(p.shiftMinutes / 6) / 10} h)`
      return p.final ? `Delivered ${t(p.p50)}` : `ETA ${t(p.p50)}${shift}, range ${t(p.p10)} – ${t(p.p90)}, ${p.confidence} confidence`
    }
    case 'ExceptionOpened':
      return `Exception opened (${e.payload.type.replace(/_/g, ' ')}): ${e.payload.summary}`
    case 'ExceptionResolved':
      return `Exception resolved by ${e.payload.resolvedBy}: ${e.payload.resolution}`
    case 'ReplanStarted':
      return `Replan ${e.payload.sagaId} started (${e.payload.trigger.replace(/_/g, ' ')}), attempt ${e.payload.attempt}`
    case 'TrainCapacityReserved':
      return `Seat reserved on ${e.payload.runId} (departs ${t(e.payload.departure)})`
    case 'TrainCapacityReleased':
      return `Seat released on ${e.payload.runId}: ${e.payload.reason}`
    case 'ReplanCompleted':
      return `Replan ${e.payload.sagaId} completed: plan v${e.payload.fromPlanVersion} → v${e.payload.toPlanVersion} on ${e.payload.chosenRunId}`
    case 'ReplanFailed':
      return `Replan ${e.payload.sagaId} failed: ${e.payload.reason}`
    case 'ReplanCompensated':
      return `Replan ${e.payload.sagaId} compensated: ${e.payload.reason}`
    case 'ShipperNotified':
      return `Digest ${e.payload.digestId} sent to ${e.payload.shipperId}: ${e.payload.subject}`
    default:
      return (e as AnyEnvelope).type
  }
}

/** Removes what a shipper must not see: other cars in a consist, other cars in a digest. */
export function redactForShipper(e: AnyEnvelope, carId: string): Record<string, unknown> {
  if (e.type === 'TrainDeparted') {
    const { consist, ...rest } = e.payload
    return { ...rest, consistSize: consist.length, thisCarAboard: consist.includes(carId) }
  }
  if (e.type === 'ShipperNotified') {
    return { ...e.payload, lines: e.payload.lines.filter((l) => l.startsWith(carId)), carIds: e.payload.carIds.filter((c) => c === carId) }
  }
  return e.payload as Record<string, unknown>
}
