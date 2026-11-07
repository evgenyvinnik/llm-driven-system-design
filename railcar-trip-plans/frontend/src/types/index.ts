export type Role = 'shipper' | 'ops' | 'admin'

export interface User {
  id: string
  username: string
  displayName: string
  role: Role
  shipperId: string | null
  shipperName: string | null
}

export interface Clock {
  now: string
  speed: number
  simulated: boolean
}

export type CarStatus = 'awaiting_pull' | 'at_yard' | 'in_transit' | 'bad_ordered' | 'off_network' | 'delivered' | 'unknown'
export type Confidence = 'observed' | 'inferred' | 'none'
export type PlanStatus = 'no_plan' | 'on_plan' | 'missed_connection' | 'replanned' | 'complete'
export type EtaConfidence = 'high' | 'medium' | 'low'

export interface EtaBasis {
  startedFrom: string
  yardHours: number
  transitHours: number
  yardShare: number
  missNextConnection: number
  nextYard: string | null
  plannedArrival: string | null
}

export interface CarRow {
  car_id: string
  trip_id: string | null
  shipper_id: string | null
  shipper_name: string | null
  plan_version: number | null
  status: CarStatus
  location_id: string | null
  train_run_id: string | null
  position_confidence: Confidence
  last_observed_at: string | null
  last_event_at: string | null
  plan_status: PlanStatus
  missed_reads: number
  late_events: number
  foreign_road: string | null
  origin_yard: string | null
  destination_yard: string | null
  destination_customer: string | null
  handoff_road: string | null
  p10: string | null
  p50: string | null
  p90: string | null
  confidence: EtaConfidence | null
  final: boolean | null
  basis: EtaBasis | null
  planned_arrival: string | null
  original_arrival: string | null
  open_exceptions: number
}

export interface Leg {
  seq: number
  trainId: string
  runId: string
  fromYard: string
  toYard: string
  plannedDeparture: string
  plannedArrival: string
}

export interface PlanVersionRow {
  trip_id: string
  version: number
  legs: Leg[]
  reason_code: string
  reason_text: string
  revised_by: string
  event_id: string
  occurred_at: string
}

export interface EtaRow {
  p10: string
  p50: string
  p90: string
  confidence: EtaConfidence
  as_of: string
  final: boolean
  plan_version: number
  basis: EtaBasis
}

export interface EtaHistoryRow {
  p10: string
  p50: string
  p90: string
  as_of: string
  plan_version: number
  trigger_type: string
}

export interface ExceptionRow {
  exception_id: string
  car_id: string
  trip_id: string | null
  shipper_id: string | null
  shipper_name?: string | null
  type: 'missed_connection' | 'train_cancelled' | 'no_capacity' | 'bad_order' | 'dwell_exceeded'
  severity: 'low' | 'medium' | 'high'
  status: 'open' | 'resolved'
  yard_id: string | null
  summary: string
  detail: Record<string, unknown>
  opened_at: string
  resolved_at: string | null
  resolved_by: string | null
  resolution: string | null
  version: number
  car_status?: CarStatus | null
  eta_p50?: string | null
}

export interface SagaStep {
  step: string
  to: string
  at: string
  simAt: string
  [key: string]: unknown
}

export interface SagaRow {
  saga_id: string
  trip_id: string
  car_id: string
  shipper_id: string
  shipper_name?: string
  trigger_type: 'inbound_delay' | 'departed_without_car' | 'train_cancelled'
  state: 'started' | 'reserved' | 'awaiting_eta' | 'completed' | 'failed' | 'compensated' | 'superseded'
  attempt: number
  parent_saga_id: string | null
  from_plan_version: number
  to_plan_version: number | null
  leg_seq: number
  yard_id: string
  missed_run_id: string
  chosen_run_id: string | null
  eta_before: { p50: string; p90: string } | null
  eta_after: { p10: string; p50: string; p90: string } | null
  error: string | null
  steps: SagaStep[]
  created_at: string
}

export interface CarDetail {
  car: CarRow & { car_type: string | null; owner_mark: string | null; arrived_at: string | null; current_leg: number | null; out_of_order_events: number; event_count: number; position_source: string | null }
  plan: { trip_id: string; origin_yard: string; destination_yard: string; destination_customer: string; handoff_road: string | null; released_at: string; current_version: number; legs: Leg[] } | null
  versions: PlanVersionRow[]
  eta: EtaRow | null
  etaHistory: EtaHistoryRow[]
  exceptions: ExceptionRow[]
  sagas: SagaRow[]
  originalDelivery: string | null
}

export interface TimelineEvent {
  position: number
  eventId: string
  type: string
  version: number
  upcastFrom: number | null
  streamId: string
  streamVersion: number
  producer: string
  occurredAt: string
  recordedAt: string
  lagMinutes: number
  late: boolean
  outOfOrder: boolean
  correlationId: string
  causationId: string | null
  summary: string
  payload: Record<string, unknown>
}

export interface Chain {
  rootId: string
  ancestors: TimelineEvent[]
  root: TimelineEvent
  descendants: TimelineEvent[]
}

export interface GroupStat {
  group: string
  topics: string[]
  lag: number
  pending: number
  stalenessSeconds: number
  dlqDepth: number
  processed: number
  duplicates: number
  lastProcessedAt: string | null
  owners: Array<{ stream: string; owner: string | null }>
  streams: Array<{ stream: string; lag: number; pending: number; lastDeliveredId: string; oldestUnfinishedAt: string | null; consumers: number }>
}

export interface StreamsOverview {
  topics: Array<{ topic: string; partitions: Array<{ stream: string; length: number; lastId: string | null; lastAt: string | null }> }>
  groups: GroupStat[]
  outbox: { backlog: number; last_position: number | null; published_through: number | null }
  rates: { eventsPerSecond: number; series: Array<{ at: string; perSecond: number }> }
  eventTypes: Array<{ type: string; version: number; n: number }>
  replays: Array<{ id: number; projection: string; finished_at: string; events_read: number; rows_live: number; rows_rebuilt: number; matches: boolean; applied: boolean }>
}

export interface DlqEntry {
  group: string
  id: string
  stream: string
  messageId: string
  eventId: string
  type: string
  key: string
  error: string
  deliveries: number
  deadAt: string
}

export interface Digest {
  digest_id: string
  shipper_id: string
  shipper_name: string
  created_at: string
  sim_time: string
  item_count: number
  car_count: number
  suppressed_count: number
  lines: Array<{ carId: string; kinds: string[]; text: string }>
}
