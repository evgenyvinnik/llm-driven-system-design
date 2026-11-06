/**
 * One-line, human-readable summaries of events for timelines and the replay tool.
 * @module events/describe
 */
import { TIER_NAMES } from '../shared/domain.js'
import type { EventEnvelope } from './envelope.js'

type P = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const tier = (t: unknown) => TIER_NAMES[Number(t)] ?? String(t)
const pos = (p: P) => (p.position === 'CAR' ? '(brake, whole car)' : p.position)
const ownerText = (o: P | null | undefined) => (o ? `${o.role} ${o.id ?? ''}`.trim() : 'nobody')
const time = (iso: unknown) => String(iso ?? '').slice(11, 16)

export function describeEvent(e: Pick<EventEnvelope, 'type' | 'payload'>): string {
  const p = e.payload as P
  switch (e.type) {
    case 'PassRecorded':
      return `${p.tripId} passed ${p.detectorId} at ${time(p.passedAt)}Z; received ${Math.round(p.lagSeconds / 60)} min later (${p.lane} lane)`
    case 'AxleReadingsRecorded':
      return `${p.readingCount} readings from ${p.detectorId} stored in the fact log (claim check); hottest bearing ${p.maxBearingF}°F`
    case 'ConsistVersionChanged':
      return `${p.tripId} consist revision ${p.revision} effective ${time(p.effectiveAt)}Z: ${p.units.length} units${p.setOut?.length ? `, set out ${p.setOut.join(', ')}` : ''}`
    case 'CarIdentified':
      return p.correctedFrom
        ? `${p.carId} corrected by AEI at ${p.detectorId}: ${p.leadingEnd}-end leading (consist said ${p.correctedFrom.leadingEnd}-end)`
        : `${p.carId} at position ${p.position} of ${p.tripId}, ${p.leadingEnd}-end leading (from ${p.source})`
    case 'IdentityQuarantined':
      return p.reason === 'awaiting_consist'
        ? `${p.detectorId} pass held: no consist for ${p.tripId} yet`
        : `${p.detectorId} pass held: ${p.detectedAxles} axles counted, consist says ${p.expectedAxles}; not guessing`
    case 'BearingTrendUpdated':
      return p.features?.previousComponent
        ? `${p.carId} ${p.position}: reading at ${p.detectorId} (${p.features.sideDelta >= 0 ? '+' : ''}${p.features.sideDelta}°F) predates the current wheelset; history only`
        : `${p.carId} ${p.position}: ${p.features?.sideDelta >= 0 ? '+' : ''}${p.features?.sideDelta}°F vs train-side median over ${p.features?.observations} readings (${tier(p.tier)})`
    case 'TripPositionUpdated':
      return `${p.symbol} at ${p.detectorId} (MP ${p.milepost}); territory ${p.territoryId}${p.nextYardId ? `, next yard ${p.nextYardId} ETA ${time(p.nextYardEta)}Z` : ''}`
    case 'TripArrived':
      return `${p.symbol} arrived at ${p.yardId}`
    case 'DetectorHealthChanged':
      return `${p.detectorId}: ${p.from} → ${p.to}${p.reason ? ` (${p.reason})` : ''}`
    case 'AlertRaised':
      return `${tier(p.tier)} ${String(p.kind).replace('_', ' ')} ${p.carId} ${pos(p)} on ${p.symbol}; owner ${ownerText(p.owner)}${p.late ? '; computed from late data' : ''}`
    case 'AlertEscalated':
      return `${tier(p.fromTier)} → ${tier(p.toTier)}; owner ${ownerText(p.owner)}${p.reopened ? '; reopened for acknowledgment' : ''}`
    case 'AlertHandedOff':
      return `Handed off ${ownerText(p.from)} → ${ownerText(p.to)} (${String(p.reason).replace('_', ' ')})`
    case 'CarHoldMoved':
      return `Hold and work order moved ${p.fromYardId} → ${p.toYardId}`
    case 'AlertAcknowledged':
      return `Acknowledged by ${p.by}: ${String(p.action).replace(/_/g, ' ')}`
    case 'AckDeadlineMissed':
      return `No acknowledgment in time: escalated to ${p.escalatedTo} (level ${p.toLevel})`
    case 'ApproachingYardWarned':
      return `Train approaching ${p.yardId} unacknowledged: yard supervisor warned`
    case 'NotificationRequested':
      return `Tell ${String(p.channel).replace('_', ' ')} ${p.target} (${p.kind})`
    case 'NotificationDelivered':
      return `Provider accepted the ${String(p.channel).replace('_', ' ')} message for ${p.target}`
    case 'CarHoldPlaced':
      return `${p.carId} ${p.status === 'bad_ordered' ? 'bad-ordered' : 'held'} at ${p.yardId}`
    case 'CarHoldReleased':
      return `Hold on ${p.carId} at ${p.yardId} released (${String(p.reason).replace(/_/g, ' ')})`
    case 'WorkOrderOpened':
      return `${p.caseType === 'audit' ? 'Random audit inspection' : 'Inspection'} of ${p.carId} ${p.position} at ${p.yardId}`
    case 'WorkOrderStarted':
      return `Inspection started by ${p.by}`
    case 'InspectionFindingRecorded':
      return `${String(p.finding).replace(/_/g, ' ')}, ${String(p.disposition).replace('_', ' ')} (${p.source})${p.supersedesFindingId ? '; supersedes a no-defect finding' : ''}`
    case 'CaseClosed':
      return `Closed: ${String(p.reason).replace(/_/g, ' ')}`
    case 'ComponentReplaced':
      return `Axle ${p.axle}: wheelset ${p.installedComponentId} installed ${time(p.installedAt)}Z${p.removedComponentId ? ` (replaces ${p.removedComponentId})` : ''}`
    default:
      return e.type
  }
}
