/**
 * Who consumes what. Each consumer group reads one or more broker streams
 * (families) and handles a set of event types. Shared by the workers that run
 * the groups and by the API's Ops page (lag, staleness, DLQ).
 *
 * Choreography is the default: each group reacts to facts and publishes its own
 * facts; nobody calls anybody. The one orchestrated flow is the acknowledgment
 * process manager (ack-process), because deadline -> escalate -> hand off needs
 * memory and durable timers.
 * @module events/topology
 */
import type { Family } from '../shared/stream.js'

export type GroupKind = 'analyzer' | 'integration' | 'process' | 'projection'

export interface GroupSpec {
  group: string
  kind: GroupKind
  /** Broker streams in priority order: after handling anything from the first, the loop starts over. */
  families: Family[]
  handles: string[]
  description: string
  /** Projection tables (rebuilt by `npm run replay -- <name>`). */
  tables?: string[]
  /** Short name used by the replay CLI. */
  name?: string
}

const CASE_LIFECYCLE = [
  'AlertRaised', 'AlertEscalated', 'AlertHandedOff', 'CarHoldMoved', 'AlertAcknowledged', 'AckDeadlineMissed', 'ApproachingYardWarned',
  'NotificationRequested', 'NotificationDelivered', 'CarHoldPlaced', 'CarHoldReleased', 'WorkOrderOpened', 'WorkOrderStarted',
  'InspectionFindingRecorded', 'CaseClosed',
]

export const GROUPS: GroupSpec[] = [
  {
    group: 'analyzer', kind: 'analyzer',
    families: ['wayside.readings.live', 'wayside.readings.backfill', 'identity', 'cars'],
    handles: ['AxleReadingsRecorded', 'ConsistVersionChanged', 'ComponentReplaced'],
    description: 'Identity, trends and risk per pass (live lane first); releases quarantined passes when a consist arrives; re-scores a car after a wheelset swap',
  },
  {
    group: 'notifier', kind: 'integration', families: ['cases'], handles: ['NotificationRequested'],
    description: 'Hands notifications to the (simulated) provider and records NotificationDelivered',
  },
  {
    group: 'workorder-sync', kind: 'integration', families: ['cases', 'cars', 'trips.position'],
    handles: ['WorkOrderOpened', 'InspectionFindingRecorded', 'CaseClosed', 'ComponentReplaced', 'TripArrived'],
    description: 'Yard maintenance integration: tickets for work orders, wheelset installs from repairs, closes repaired cases, opens audit cases on arrival',
  },
  {
    group: 'ack-process', kind: 'process', families: ['cases', 'trips.position'],
    handles: ['AlertRaised', 'AlertEscalated', 'AlertHandedOff', 'AckDeadlineMissed', 'ApproachingYardWarned', 'AlertAcknowledged', 'WorkOrderStarted', 'InspectionFindingRecorded', 'CaseClosed', 'NotificationDelivered', 'TripPositionUpdated'],
    description: 'Process manager: durable acknowledgment timers, escalation up the chain, approaching-yard warnings, handoffs as the train moves',
  },
  {
    group: 'proj-alert-queue', kind: 'projection', name: 'alert-queue', families: ['cases', 'cars', 'trends'],
    handles: [...CASE_LIFECYCLE, 'BearingTrendUpdated'],
    tables: ['alerts', 'car_holds', 'work_orders', 'findings', 'notifications', 'bearing_trends_latest'],
    description: 'Alert queue, holds, work orders, findings, notifications and the latest trend per bearing',
  },
  {
    group: 'proj-car-history', kind: 'projection', name: 'car-history', families: ['cars', 'identity'],
    handles: ['ComponentReplaced', 'CarIdentified'],
    tables: ['component_installs', 'car_trips'],
    description: 'Wheelset installs per axle and the trips each car ran, with orientation',
  },
  {
    group: 'proj-detector-health', kind: 'projection', name: 'detector-health', families: ['wayside.passes', 'detectors.health'],
    handles: ['PassRecorded', 'DetectorHealthChanged'],
    tables: ['detector_health'],
    description: 'Detector status and pass freshness',
  },
  {
    group: 'proj-reliability', kind: 'projection', name: 'reliability', families: ['cases', 'cars'],
    handles: ['AlertRaised', 'AlertEscalated', 'AlertHandedOff', 'AlertAcknowledged', 'AckDeadlineMissed', 'WorkOrderOpened', 'InspectionFindingRecorded', 'CaseClosed'],
    tables: ['reliability_facts'],
    description: 'One fact row per case and per stand-alone finding, for precision and recall',
  },
]

export const groupSpec = (group: string) => GROUPS.find((g) => g.group === group)
export const projectionSpecs = () => GROUPS.filter((g) => g.kind === 'projection')
