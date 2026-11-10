/**
 * The yard's vocabulary: tracks, blocks, cars, trains, moves, locks and the
 * snapshot a solve reads. Plain data with times as epoch milliseconds on the
 * simulated clock. These are only types, so the planner and the validator can
 * both describe the same world without sharing any logic.
 * @module domain/types
 */

export type TrackKind = 'receiving' | 'classification' | 'departure'

export interface TrackDef {
  id: string
  name: string
  kind: TrackKind
  capacityFt: number
  open: boolean
}

/** Standing order: a block's cars go on its standing track, or on an approved alternate. */
export interface BlockDef {
  id: string
  name: string
  destination: string
  standingTrackId: string
  alternateTrackIds: string[]
}

export type CarPosition = 'inbound' | 'on_track' | 'unknown' | 'departed'

export interface CarState {
  id: string
  lengthFt: number
  tons: number
  blockId: string
  hazmatClass: string | null
  inboundId: string | null
  consistPos: number
  position: CarPosition
  trackId: string | null
  held: boolean
  coupledTo: string | null
  coupledSeq: number | null
  arrivedAt: number | null
}

export interface InboundDef {
  id: string
  symbol: string
  scheduledArrival: number
  eta: number
  actualArrival: number | null
  receivingTrackId: string | null
}

export interface OutboundDef {
  id: string
  symbol: string
  scheduledDeparture: number
  /** Effective departure: scheduled, or the yardmaster's recorded revision. */
  departure: number
  blockSequence: string[]
  maxLengthFt: number
  maxTons: number
  minCars: number
  status: 'planned' | 'departed' | 'missed'
}

export type MoveKind = 'receive' | 'classify' | 'assemble' | 'setout'
export type Crew = 'road' | 'hump' | 'trim'

export interface PlanMove {
  /** Stable across versions: the same logical move keeps its key, which is what a diff compares. */
  key: string
  kind: MoveKind
  crew: Crew
  carIds: string[]
  fromTrackId: string | null
  toTrackId: string
  blockId: string | null
  inboundId: string | null
  outboundId: string | null
  plannedStart: number
  plannedEnd: number
}

export type ExecutionStatus = 'pending' | 'in_progress' | 'done' | 'cancelled'

export interface MoveExecution {
  key: string
  status: ExecutionStatus
  startedAt: number | null
  completedAt: number | null
  /** The move as it was started (cars, tracks), so later versions can carry it verbatim. */
  move: PlanMove | null
}

export type LockKind = 'move' | 'car_track' | 'sequence'

export interface LockDef {
  id: string
  kind: LockKind
  /** kind=move or sequence: the pinned move. */
  moveKey: string | null
  /** kind=sequence: `moveKey` must stay ahead of this move. */
  beforeKey: string | null
  /** kind=car_track: this car must land on `trackId`. */
  carId: string | null
  trackId: string | null
  /** kind=move: the content the lock pins. */
  move: PlanMove | null
  by: string
  reason: string
}

/** Rail practice reduced to numbers. Illustrative assumptions, not any railroad's standards. */
export interface YardRules {
  receiveMin: number
  inspectMin: number
  classifyFixedMin: number
  classifyPerCarMin: number
  assembleFixedMin: number
  assemblePerCarMin: number
  setoutMin: number
  brakeTestMin: number
  /** Don't start building a train more than this long before it leaves (keeps departure tracks free). */
  assembleWindowMin: number
  frozenHorizonMin: number
  /** Simplified from real position-in-train rules: at least this many non-placarded cars behind the locomotive. */
  hazmatBufferCars: number
  /** Simplified: these placard pairs may not be adjacent. */
  hazmatIncompatible: [string, string][]
}

export interface YardSnapshot {
  yardId: string
  shiftId: number
  stateVersion: number
  now: number
  tracks: TrackDef[]
  blocks: BlockDef[]
  cars: CarState[]
  inbound: InboundDef[]
  outbound: OutboundDef[]
  locks: LockDef[]
  executions: Record<string, MoveExecution>
  rules: YardRules
}

export type ViolationSeverity = 'safety' | 'physical' | 'operating'

export interface Violation {
  code: string
  severity: ViolationSeverity
  message: string
  moveKey?: string
  carIds?: string[]
  trackId?: string
  outboundId?: string
  lockId?: string
  overBy?: number
}

export interface TrainReadiness {
  outboundId: string
  symbol: string
  departure: number
  scheduledDeparture: number
  cars: number
  lengthFt: number
  tons: number
  readyAt: number | null
  slackMin: number | null
  minCars: number
  status: 'ready' | 'short' | 'annulled' | 'late' | 'departed' | 'missed' | 'blocked'
}

export interface ValidationResult {
  ok: boolean
  publishable: boolean
  violations: Violation[]
  readiness: TrainReadiness[]
  timeline: Record<string, { start: number; end: number }>
  peakFt: Record<string, number>
}

export type ConflictCode =
  | 'LOCK_HELD_CAR'
  | 'LOCK_TRACK_BLOCKED'
  | 'LOCK_CAPACITY'
  | 'LOCK_MISSES_DEPARTURE'
  | 'LOCK_SEQUENCE'
  | 'LOCK_NOT_HONOURED'

export interface LockConflict {
  lockId: string
  code: ConflictCode
  message: string
  moveKey?: string | null
  carId?: string | null
  trackId?: string | null
  options: ('release_lock' | 'retarget_lock' | 'revise_departure')[]
}

export type ConsequenceKind = 'departure_missed' | 'cars_rolled' | 'cars_unassigned' | 'frozen_move_changed' | 'train_short'

export interface Consequence {
  kind: ConsequenceKind
  message: string
  outboundId?: string
  toOutboundId?: string | null
  carIds?: string[]
  moveKey?: string
  /** Estimated earliest the missed train's cars could have been ready. */
  earliestReady?: number | null
  reason?: string
}

export interface CostBreakdown {
  total: number
  annulledTrains: number
  unassignedCars: number
  dwellCarHours: number
  moves: number
  alternateCuts: number
  changedMoves: number
}

export interface MoveDiffCounts {
  kept: number
  changed: number
  reordered: number
  added: number
  removed: number
  retimed: number
  /** changed + reordered + added + removed: the instructions a crew would have to relearn. */
  disturbed: number
}
