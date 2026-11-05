/**
 * Row-to-JSON mappers. The API speaks camelCase; PostgreSQL speaks snake_case.
 */
import { TIER_NAMES } from '../shared/domain.js'

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null)

export interface AlertRow {
  id: string
  trip_id: string
  car_id: string
  kind: string
  position: string
  tier: number
  status: string
  action: string
  routing: string
  desk_id: string | null
  territory_id: string | null
  yard_id: string | null
  reasons: string[]
  features: Record<string, unknown>
  route_note: string | null
  trigger_detector_id: string | null
  trigger_passed_at: Date | null
  data_lag_seconds: number
  late: boolean
  opened_at: Date
  escalated_at: Date | null
  updated_at: Date
  acknowledged_by: string | null
  acknowledged_at: Date | null
  ack_action: string | null
  ack_note: string | null
  closed_at: Date | null
  outcome: string | null
  version: number
  symbol?: string
  direction?: string
  trip_status?: string
  owner_mark?: string | null
  work_order_id?: string | null
  work_order_status?: string | null
  hold_status?: string | null
}

export function alertDto(r: AlertRow) {
  return {
    id: r.id,
    tripId: r.trip_id,
    symbol: r.symbol ?? null,
    direction: r.direction ?? null,
    tripStatus: r.trip_status ?? null,
    carId: r.car_id,
    ownerMark: r.owner_mark ?? null,
    kind: r.kind,
    position: r.position,
    tier: r.tier,
    tierName: TIER_NAMES[r.tier],
    status: r.status,
    action: r.action,
    routing: r.routing,
    deskId: r.desk_id,
    territoryId: r.territory_id,
    yardId: r.yard_id,
    reasons: r.reasons,
    features: r.features,
    routeNote: r.route_note,
    triggerDetectorId: r.trigger_detector_id,
    triggerPassedAt: iso(r.trigger_passed_at),
    dataLagSeconds: r.data_lag_seconds,
    late: r.late,
    openedAt: iso(r.opened_at),
    escalatedAt: iso(r.escalated_at),
    updatedAt: iso(r.updated_at),
    acknowledgedBy: r.acknowledged_by,
    acknowledgedAt: iso(r.acknowledged_at),
    ackAction: r.ack_action,
    ackNote: r.ack_note,
    closedAt: iso(r.closed_at),
    outcome: r.outcome,
    version: r.version,
    workOrderId: r.work_order_id ?? null,
    workOrderStatus: r.work_order_status ?? null,
    holdStatus: r.hold_status ?? null,
  }
}

export interface TripRow {
  trip_id: string
  symbol: string
  direction: string
  origin_yard_id: string
  destination_yard_id: string
  stops: string[]
  status: string
  departed_at: Date
  arrived_at: Date | null
  arrived_yard_id: string | null
  speed_mph: number | null
  last_detector_id: string | null
  last_milepost: number | null
  last_pass_at: Date | null
  territory_id: string | null
  next_yard_id: string | null
  next_yard_eta: Date | null
  car_count?: number
  open_alerts?: number
  max_tier?: number | null
}

export function tripDto(r: TripRow) {
  return {
    tripId: r.trip_id,
    symbol: r.symbol,
    direction: r.direction,
    originYardId: r.origin_yard_id,
    destinationYardId: r.destination_yard_id,
    stops: r.stops,
    status: r.status,
    departedAt: iso(r.departed_at),
    arrivedAt: iso(r.arrived_at),
    arrivedYardId: r.arrived_yard_id,
    speedMph: r.speed_mph,
    lastDetectorId: r.last_detector_id,
    lastMilepost: r.last_milepost,
    lastPassAt: iso(r.last_pass_at),
    territoryId: r.territory_id,
    nextYardId: r.next_yard_id,
    nextYardEta: iso(r.next_yard_eta),
    carCount: r.car_count ?? null,
    openAlerts: r.open_alerts ?? 0,
    maxTier: r.max_tier ?? null,
  }
}

export interface WorkOrderRow {
  id: string
  alert_id: string
  car_id: string
  position: string
  kind: string
  yard_id: string
  priority: number
  status: string
  assigned_to: string | null
  created_at: Date
  completed_at: Date | null
  version: number
  symbol?: string
  trip_id?: string
  trip_status?: string
  next_yard_eta?: Date | null
  arrived_at?: Date | null
  reasons?: string[]
  route_note?: string | null
  late?: boolean
  data_lag_seconds?: number
  finding?: string | null
  disposition?: string | null
  finding_notes?: string | null
  recorded_by?: string | null
  hold_status?: string | null
}

export function workOrderDto(r: WorkOrderRow) {
  return {
    id: r.id,
    alertId: r.alert_id,
    carId: r.car_id,
    position: r.position,
    kind: r.kind,
    yardId: r.yard_id,
    priority: r.priority,
    priorityName: TIER_NAMES[r.priority],
    status: r.status,
    assignedTo: r.assigned_to,
    createdAt: iso(r.created_at),
    completedAt: iso(r.completed_at),
    version: r.version,
    symbol: r.symbol ?? null,
    tripId: r.trip_id ?? null,
    tripStatus: r.trip_status ?? null,
    nextYardEta: iso(r.next_yard_eta),
    arrivedAt: iso(r.arrived_at),
    reasons: r.reasons ?? [],
    routeNote: r.route_note ?? null,
    late: r.late ?? false,
    dataLagSeconds: r.data_lag_seconds ?? 0,
    finding: r.finding ?? null,
    disposition: r.disposition ?? null,
    findingNotes: r.finding_notes ?? null,
    recordedBy: r.recorded_by ?? null,
    holdStatus: r.hold_status ?? null,
  }
}

export { iso }
