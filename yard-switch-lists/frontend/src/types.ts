/** Shapes the API returns. Times are ISO strings on the simulated yard clock. */

export type Role = 'yardmaster' | 'crew' | 'admin'

export interface User {
  id: string
  username: string
  displayName: string
  role: Role
}

export type MoveStatus = 'pending' | 'in_progress' | 'done' | 'cancelled'

export interface Move {
  key: string
  kind: 'receive' | 'classify' | 'assemble' | 'setout'
  crew: 'road' | 'hump' | 'trim'
  carIds: string[]
  carCount: number
  fromTrackId: string | null
  toTrackId: string
  blockId: string | null
  inboundId: string | null
  outboundId: string | null
  plannedStart: string
  plannedEnd: string
  status: MoveStatus
  startedAt: string | null
  completedAt: string | null
  lockId: string | null
  heldCars: string[]
}

export interface Violation {
  code: string
  severity: 'safety' | 'physical' | 'operating'
  message: string
  moveKey?: string
  carIds?: string[]
  trackId?: string
  outboundId?: string
  lockId?: string
  overBy?: number
}

export interface Conflict {
  lockId: string
  code: string
  message: string
  moveKey?: string | null
  carId?: string | null
  trackId?: string | null
  options: string[]
}

export interface Consequence {
  kind: 'departure_missed' | 'cars_rolled' | 'cars_unassigned' | 'frozen_move_changed' | 'train_short'
  message: string
  outboundId?: string
  toOutboundId?: string | null
  carIds?: string[]
  moveKey?: string
  earliestReady?: number | null
  reason?: string
}

export interface DiffCounts {
  kept: number
  changed: number
  reordered: number
  added: number
  removed: number
  retimed: number
  disturbed: number
}

export interface Stability {
  stable: DiffCounts
  fromScratch: DiffCounts
  frozenMoves: number
  horizonMoves: number
  frozenHorizonMin: number
}

export interface PlanVersion {
  id: string
  shiftId: number
  versionNo: number
  status: 'draft' | 'published' | 'superseded'
  parentId: string | null
  authorKind: 'planner' | 'person'
  authorName: string
  reason: string
  basedOnStateVersion: number
  solveId: string | null
  objective: { total?: number; annulledTrains?: number; unassignedCars?: number; dwellCarHours?: number; moves?: number; changedMoves?: number }
  validation: { ok?: boolean; violations?: Violation[] }
  conflicts: Conflict[]
  consequences: Consequence[]
  stability: Stability | null
  reviewRequired: boolean
  createdAt: string
  publishedAt: string | null
  publishedBy: string | null
  moveCount?: number
}

export interface TrackCar {
  id: string
  blockId: string
  lengthFt: number
  hazmatClass: string | null
  held: boolean
  coupledTo: string | null
}

export interface TrackView {
  id: string
  name: string
  kind: 'receiving' | 'classification' | 'departure'
  capacityFt: number
  open: boolean
  occupiedFt: number
  carCount: number
  peakPlannedFt: number
  blocks: Record<string, number>
  cars: TrackCar[]
}

export interface Readiness {
  outboundId: string
  symbol: string
  departure: string
  scheduledDeparture: string
  cars: number
  lengthFt: number
  tons: number
  readyAt: string | null
  slackMin: number | null
  minCars: number
  status: 'ready' | 'short' | 'annulled' | 'late' | 'departed' | 'missed' | 'blocked'
}

export interface InboundView {
  id: string
  symbol: string
  scheduledArrival: string
  eta: string
  actualArrival: string | null
  receivingTrackId: string | null
  carCount: number
  slipMin: number
}

export interface AlertView {
  id: string
  kind: string
  severity: 'critical' | 'warning' | 'info'
  message: string
  carId: string | null
  outboundId: string | null
  moveKey: string | null
  simAt: string
  status?: string
}

export interface LockView {
  id: string
  kind: 'move' | 'car_track' | 'sequence'
  moveKey: string | null
  beforeKey: string | null
  carId: string | null
  trackId: string | null
  by: string
  reason: string
  createdAt: string
}

export interface Board {
  now: string
  shiftId: number
  shiftStartsAt: string
  shiftEndsAt: string
  stateVersion: number
  autoPublish: boolean
  head: PlanVersion | null
  working: PlanVersion | null
  workingIsHead: boolean
  stale: boolean
  moves: Move[]
  validation: { ok: boolean; violations: Violation[] }
  readiness: Readiness[]
  tracks: TrackView[]
  inbound: InboundView[]
  alerts: AlertView[]
  solving: { id: string; purpose: string; status: string; reason: string; attempts: number; triggerCount: number }[]
  pendingTriggers: number
  locks: LockView[]
  carsInYard: number
}

export interface CrewMove extends Move {
  ready: boolean
  blockedByHold: boolean
}

export interface CrewView {
  now: string
  shiftId: number
  stateVersion: number
  versionNo: number | null
  versionId: string | null
  replanPending: boolean
  trains: Record<string, string>
  moves: CrewMove[]
  tracks: { id: string; name: string; open: boolean }[]
}

export interface MoveChange {
  key: string
  type: 'kept' | 'changed' | 'reordered' | 'added' | 'removed'
  fields: string[]
  shiftMin: number
  frozen: boolean
  why: string
  before: { key: string; kind: string; carCount: number; fromTrackId: string | null; toTrackId: string; outboundId: string | null; plannedStart: string } | null
  after: { key: string; kind: string; carCount: number; fromTrackId: string | null; toTrackId: string; outboundId: string | null; plannedStart: string } | null
}

export interface PlanDiff {
  from: PlanVersion | null
  to: PlanVersion
  counts: DiffCounts | null
  triggers: { kind: string; detail: Record<string, unknown> }[]
  frozen: string[]
  changes: MoveChange[]
}

export interface OverrideRow {
  id: string
  kind: string
  actor: string
  reason: string
  reasonCode: string
  before: unknown
  after: unknown
  violations: Violation[]
  refused: boolean
  fromVersionNo: number | null
  toVersionNo: number | null
  simAt: string
}

export interface ComparisonRow {
  instance: string
  kind: 'small' | 'full'
  algorithm: 'greedy' | 'local_search' | 'exact'
  timeLimitMs: number
  cost: number
  elapsedMs: number
  iterations: number
  terminatedBy: string
  provenOptimal: boolean | null
  gapPct: number | null
  valid: boolean
  moves: number
}

export interface ComparisonData {
  run: { id: string; summary: Record<string, number | string | null>; createdAt: string; finishedAt: string } | null
  rows: ComparisonRow[]
  active: { id: string; status: string } | null
}

export interface ShiftMetrics {
  shiftId: number
  status: string
  startsAt: string
  endsAt: string
  trainsDue: number
  departedOnTime: number
  departedLate: number
  missed: number
  onTimePct: number | null
  carsHandled: number
  handlings: number
  movesPerCar: number | null
  carsDeparted: number
  avgDwellHours: number | null
  carsOnHand: number | null
  capacityViolations: number
  overrides: number
  refusedOverrides: number
  plannedMoves: number
  overrideRatePer100Moves: number | null
  overrideReasons: Record<string, number>
  planVersions: number
  replans: number
  crewReports: number
  crewExceptions: number
}

export interface ReplayPolicyRow {
  policy: 'planner' | 'planner_overrides' | 'baseline'
  shifts: number
  onTimePct: number
  missed: number
  carsDeparted: number
  carsStranded: number
  movesPerCar: number
  avgDwellHours: number
  capacityViolations: number
  overrides: number
  overrideReasons: Record<string, number>
  disturbedMoves: number
  invalidPlans: number
}

export interface ReplayData {
  run: {
    id: string
    params: { seeds: number[]; iterations: number }
    summary: { policies: ReplayPolicyRow[]; perSeed: { seed: number; policy: string; metrics: { onTimePct: number; carsDeparted: number; overrides: number; avgDwellHours: number }; digest: string }[] }
    createdAt: string
  } | null
  active: { id: string; status: string } | null
}

export interface HoldRow {
  holdId: string
  carId: string
  status: string
  reason: string | null
  streamId: string
  streamVersion: number
  placedAt: string | null
  releasedAt: string | null
  releasedBy: string | null
  position: string | null
  trackId: string | null
  coupledTo: string | null
  blockId: string | null
}

export interface HoldEventRow {
  eventId: string
  type: string
  version: number
  streamId: string
  streamVersion: number
  occurredAt: string
  holdId: string | null
  carId: string | null
  outcome: string
  via: string
  receivedAt: string
}

export interface SimState {
  seed: number
  running: boolean
  speed: number
  now: string | null
  exceptionRate: number
  autoRoll: boolean
  crews: { hump: { key: string; finishAt: string } | null; trim: { key: string; finishAt: string } | null }
  delayedReports: number
  dropNext: number
  eventCount: number
  digest: string
  scenarioDigest: string
  recent: string[]
  lastError: string | null
}

export interface CrewReportInput {
  clientReportId: string
  moveKey?: string | null
  kind: 'start' | 'complete' | 'exception'
  occurredAt?: string
  offline?: boolean
  exceptionType?: 'car_not_found' | 'track_blocked' | 'different_cars'
  carIds?: string[]
  actualToTrackId?: string
  trackId?: string
  note?: string
}

export interface CrewReportResult {
  clientReportId: string
  moveKey: string | null
  outcome: string
  duplicate: boolean
  mismatch: boolean
  message?: string
}
