export type Role = 'fuel_desk' | 'crew' | 'admin'

export interface User {
  id: string
  username: string
  displayName: string
  role: Role
  trainId: string | null
}

export interface UnitView {
  locomotiveId: string
  model: string
  role: string
  capacityGal: number
  reserveGal: number
  fuelGal: number | null
  fuelRaw: number | null
  fuelPct: number | null
  notch: number | null
  engineState: string | null
  calibration: number
  sensorSuspect: boolean
  leakSuspect: boolean
}

export interface NextStop {
  locationId: string
  name: string
  kind: 'pad' | 'dtl'
  etaMs: number
  gallons: number
  orderStatus: string | null
}

export type Lifecycle = 'recommended' | 'accepted' | 'proposed' | 'superseded' | 'rejected'
export type Confidence = 'high' | 'medium' | 'low'
export type PlanSource = 'dp' | 'greedy_fallback' | 'last_good'

export interface TrainSummary {
  id: string
  symbol: string
  routeId: string
  origin: string
  destination: string
  status: 'running' | 'arrived'
  plannedTons: number
  cars: number
  milepost: number
  totalMiles: number
  progressPct: number
  speedMph: number
  lastSeenMs: number | null
  nextLocation: { id: string; name: string; milepost: number } | null
  calibration: number
  units: UnitView[]
  plan: {
    version: number
    status: string
    lifecycle: Lifecycle
    source: PlanSource
    confidence: Confidence
    costTotal: number
    stops: number
    nextStop: NextStop | null
    createdAt: string
    proposalVersion: number | null
    purchaseCost: number
  } | null
  alerts: { critical: number; warning: number }
}

export interface FleetResponse {
  simNow: number
  trains: TrainSummary[]
  summary: { running: number; openAlerts: number; activeOrders: number; plannedFuelCost: number; lowestFuelPct: number }
}

export interface UnitFill {
  locomotiveId: string
  arrivalGal: number
  targetGal: number
  gallons: number
}

export interface PlanStop {
  seq: number
  stopKey: string
  locationId: string
  name: string
  optionId: string
  kind: 'pad' | 'dtl'
  milepost: number
  etaMs: number
  gallons: number
  perUnit: UnitFill[]
  pricePerGal: number
  fuelCost: number
  fee: number
  delayCost: number
  dwellMinutes: number
  queueMinutes: number
  committed: boolean
  orderStatus: string | null
  orderId: number | null
  commitment: 'accepted' | 'executing' | 'fueled' | 'cancelled' | 'expired' | null
  slotStart: string | null
  slotEnd: string | null
  expiresAt: string | null
}

export interface ProfilePoint {
  milepost: number
  locationId: string | null
  fuelGal: number
  kind: 'start' | 'arrive' | 'depart'
}

export interface Profile {
  points: ProfilePoint[]
  reserveGal: number
  capacityGal: number
}

export interface CostBreakdown {
  fuel: number
  fees: number
  delay: number
  stops: number
  cancellations: number
  terminalCredit: number
  total: number
}

export interface Plan {
  id: number
  version: number
  status: 'ok' | 'emergency' | 'infeasible'
  lifecycle: Lifecycle
  acceptedBy: string | null
  acceptedAt: string | null
  source: PlanSource
  confidence: Confidence
  assumptions: string[]
  trigger: string
  reason: string
  createdAt: string
  milepost: number
  costTotal: number
  costBreakdown: CostBreakdown
  greedyCost: number | null
  greedyStops: string | null
  inputs: { unavailable?: string[]; queues?: string[]; dataAgeHours?: number; marginPct?: number; trainCalibration?: number }
  profile: Profile
  stops: PlanStop[]
}

export interface Proposal {
  version: number
  reason: string
  costTotal: number
  costBreakdown: CostBreakdown
  createdAt: string
  profile: Profile
  stops: { seq: number; name: string; optionId: string; kind: string; gallons: number; etaMs: number; fuelCost: number }[]
}

export interface PlanVersion {
  version: number
  status: string
  lifecycle: Lifecycle
  source: PlanSource
  acceptedBy: string | null
  trigger: string
  reason: string
  createdAt: string
  costTotal: number
  milepost: number
  signature: string
}

export interface Evaluation {
  id: number
  evaluatedAt: string
  trigger: string
  triggerDetail: string | null
  decision: string
  currentVersion: number | null
  resultingVersion: number
  incumbentCost: number | null
  candidateCost: number
  candidateStops: string
  explanation: string
  source: PlanSource
  confidence: Confidence
  durationMs: number
}

export interface PathNode {
  locationId: string
  name: string
  state: string
  milepost: number
  fuel: { optionId: string; kind: 'pad' | 'dtl'; pricePerGal: number }[]
}

export interface AlertRow {
  id: number
  type: string
  severity: 'info' | 'warning' | 'critical'
  trainId: string | null
  symbol?: string | null
  locomotiveId: string | null
  message: string
  status: 'open' | 'acknowledged' | 'resolved'
  raisedAt: string
  acknowledgedBy?: string | null
}

export interface TrainDetail {
  simNow: number
  train: TrainSummary & { path: PathNode[] }
  plan: Plan | null
  proposal: Proposal | null
  projection: { evaluatedAt: string; trigger: string; decision: string; explanation: string; projection: Profile & { cost: CostBreakdown } } | null
  versions: PlanVersion[]
  evaluations: Evaluation[]
  orders: { id: number; stopKey: string; name: string; status: string; gallonsRequested: number; vendorOrderId: string | null; attempts: number; lastError: string | null }[]
  alerts: AlertRow[]
  tickets: { id: string; source: string; locationId: string; gallonsTotal: number; status: string; telemetryGallons: number | null; pricePerGal: number }[]
}

export interface OrderRow {
  id: number
  stopKey: string
  trainId: string
  symbol: string
  locationId: string
  locationName: string
  optionId: string
  vendor: string
  planVersion: number
  gallonsRequested: number
  gallonsDelivered: number | null
  etaMs: number
  status: string
  vendorOrderId: string | null
  attempts: number
  lastError: string | null
  cancelFee: number | null
  updatedAt: string
  events: { at: string; from: string | null; to: string; note: string | null }[]
}

export interface TicketRow {
  id: string
  source: 'pad' | 'vendor'
  trainId: string
  symbol: string
  locationName: string
  gallonsTotal: number
  telemetryGallons: number | null
  discrepancyGal: number | null
  pricePerGal: number
  fee: number
  status: string
  deliveredAt: string
}

export interface FuelOption {
  id: string
  locationId: string
  locationName: string
  state: string
  kind: 'pad' | 'dtl'
  vendor: string
  pricePerGal: number
  fee: number
  setupMinutes: number
  pumpGpm: number
  leadTimeHours: number
  cancelFee: number
  bays: number
  active: boolean
  updatedAt: string
}

export interface PriceChange {
  optionId: string
  pricePerGal: number
  effectiveAt: string
  changedBy: string
  note: string | null
}

export type Params = Record<string, number | boolean>

export interface VendorSettings {
  latencyMs: number
  failNext: number
  timeoutNext: number
  rejectNext: number
  hangMs: number
  shortFillPct: number
  cancelFee: number
}

export interface TelemetryPoint {
  locomotiveId: string
  seq: number
  t: number
  milepost: number
  speed: number
  notch: number
  raw: number
  smoothed: number | null
  late: boolean
}
