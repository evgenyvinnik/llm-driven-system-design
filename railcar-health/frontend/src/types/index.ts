export type Role = 'dispatcher' | 'yard' | 'admin'

export interface User {
  id: string
  username: string
  displayName: string
  role: Role
  deskId: string | null
  yardId: string | null
}

export interface Clock {
  now: string
  speed: number
  simulated: boolean
}

export interface AlertFeatures {
  observations?: number
  aboveAmbient?: number
  sideDelta?: number
  maxSideDelta?: number
  medianSideDelta?: number
  risePer15mi?: number | null
  consecutiveElevated?: number
  percentile?: number
  maxGapMiles?: number
  coverageGap?: boolean
  biasCorrected?: boolean
  historyElevatedTrips?: number
  wheelDelta?: number
  brakingZoneReadings?: number
  coldWheelReadings?: number
  edgeAlarm?: boolean
  lastDetectorId?: string
  lastMilepost?: number
}

export interface Alert {
  id: string
  tripId: string
  symbol: string | null
  direction: string | null
  tripStatus: string | null
  carId: string
  ownerMark: string | null
  kind: 'hot_bearing' | 'hot_wheel' | 'cold_wheel'
  position: string
  tier: number
  tierName: string
  status: 'open' | 'acknowledged' | 'inspected' | 'closed'
  ownerRole: 'dispatcher' | 'yard' | 'owner' | null
  ownerId: string | null
  escalationLevel: number
  ackDueAt: string | null
  deliveredAt: string | null
  inspectedAt: string | null
  action: string
  routing: string
  deskId: string | null
  territoryId: string | null
  yardId: string | null
  reasons: string[]
  features: AlertFeatures
  routeNote: string | null
  triggerDetectorId: string | null
  triggerPassedAt: string | null
  dataLagSeconds: number
  late: boolean
  openedAt: string
  escalatedAt: string | null
  updatedAt: string
  acknowledgedBy: string | null
  acknowledgedAt: string | null
  ackAction: string | null
  ackNote: string | null
  closedAt: string | null
  outcome: string | null
  version: number
  workOrderId: string | null
  workOrderStatus: string | null
  holdStatus: string | null
}

export interface AlertEvent {
  kind: string
  tier: number | null
  detectorId: string | null
  passId: string | null
  note: string | null
  actor: string
  at: string
}

export interface AlertNotification {
  channel: string
  target: string
  kind: string
  message: string
  createdAt: string
}

export interface Trip {
  tripId: string
  symbol: string
  direction: 'EB' | 'WB'
  originYardId: string
  destinationYardId: string
  stops: string[]
  status: 'en_route' | 'arrived'
  departedAt: string
  arrivedAt: string | null
  arrivedYardId: string | null
  speedMph: number | null
  lastDetectorId: string | null
  lastMilepost: number | null
  lastPassAt: string | null
  territoryId: string | null
  nextYardId: string | null
  nextYardEta: string | null
  carCount: number | null
  openAlerts: number
  maxTier: number | null
}

export interface TripUnit {
  position: number
  unitId: string
  unitType: 'locomotive' | 'car'
  axleCount: number
  leadingEnd: 'A' | 'B'
  orientationSource: 'consist' | 'aei'
  correctedByDetector: string | null
  ownerMark: string | null
  carType: string | null
}

export interface TripPass {
  detectorId: string
  passId: string
  name: string
  milepost: number
  passedAt: string
  receivedAt: string
  lagSeconds: number
  late: boolean
  ambientF: number
  speedMph: number
  identityStatus: string
  hasAei: boolean
  edgeAlarms: Array<{ axleSeq: number; rail: string }>
  detectorStatus: string
}

export interface HeatmapPass {
  detectorId: string
  passId: string
  name: string
  milepost: number
  passedAt: string
  lagSeconds: number
  late: boolean
  ambientF: number
  medians: { N: number | null; S: number | null }
  biasOffsetF: number | null
  values: { N: Array<number | null>; S: Array<number | null> }
}

export interface Heatmap {
  tripId: string
  direction: 'EB' | 'WB'
  columns: Array<{ seq: number; carId: string; carIndex: number; seqInCar: number }>
  passes: HeatmapPass[]
  highlights: Array<{ alertId: string; carId: string; position: string; tier: number; kind: string; column: number; span: number; rail: 'N' | 'S' | null }>
}

export interface CarDetail {
  car: { carId: string; ownerMark: string; ownerName: string; carType: string; axleCount: number }
  holds: Array<{ id: string; alertId: string; yardId: string; yardName: string; status: string; reason: string; createdAt: string; releasedAt: string | null }>
  alerts: Alert[]
  trips: Array<{ tripId: string; symbol: string; direction: string; departedAt: string; status: string; position: number; leadingEnd: string; orientationSource: string; correctedByDetector: string | null }>
  bearings: Array<{ position: string; observations: number; maxSideDelta: number; lastSideDelta: number }>
  components: Array<{ axle: number; componentId: string; installedAt: string; removedAt: string | null; recordedAt: string; recordedBy: string }>
}

export interface TrendPoint {
  detectorId: string
  milepost: number
  distance: number
  passedAt: string
  lagSeconds: number
  aboveAmbient: number
  sideDelta: number | null
  componentId: string | null
  superseded: boolean
}

export interface TrendSeries {
  tripId: string
  symbol: string
  direction: string
  departedAt: string
  points: TrendPoint[]
}

export interface WorkOrder {
  id: string
  alertId: string | null
  carId: string
  position: string
  kind: string
  yardId: string
  priority: number
  priorityName: string
  status: 'open' | 'in_progress' | 'completed' | 'cancelled'
  assignedTo: string | null
  createdAt: string
  completedAt: string | null
  symbol: string | null
  tripId: string | null
  tripStatus: string | null
  nextYardEta: string | null
  arrivedAt: string | null
  reasons: string[]
  routeNote: string | null
  late: boolean
  dataLagSeconds: number
  finding: string | null
  disposition: string | null
  findingNotes: string | null
  recordedBy: string | null
  holdStatus: string | null
}

export interface Hold {
  id: string
  carId: string
  alertId: string
  yardId: string
  status: 'active' | 'bad_ordered' | 'released'
  reason: string
  createdAt: string
  releasedAt: string | null
  releasedBy: string | null
  tier: number
  position: string
  kind: string
}

export interface Yard {
  id: string
  name: string
  milepost: number
  subdivisionId: string
  openWork?: number
  activeHolds?: number
}

export interface Detector {
  id: string
  name: string
  milepost: number
  subdivisionId: string
  hasAei: boolean
  brakingZone: boolean
  gatewayId: string
  status: 'ok' | 'offline' | 'silent' | 'biased'
  statusReason: string | null
  statusSince: string | null
  lastHeardAt: string | null
  lastPassAt: string | null
  bufferedPasses: number
  selfTest: string
  biasOffsetF: number | null
  biasSamples: number
  missedPasses: number
  pendingPasses: number
  lastReceivedAt: string | null
  coverage: 'live' | 'delayed' | 'catching_up' | 'gap'
}

export interface Subdivision {
  id: string
  name: string
  startMp: number
  endMp: number
  deskId: string
}

export interface Network {
  desks: Array<{ id: string; name: string }>
  subdivisions: Subdivision[]
  yards: Yard[]
  detectors: Detector[]
  coverageGaps: Array<{ fromMp: number; toMp: number; miles: number; causes: string[] }>
  maxSpacingMiles: number
  lanes: { live: number | null; backfill: number | null }
  clock: Clock
}

export type Thresholds = Record<string, number>

export interface TierStats {
  tier: string
  alerts: number
  defects: number
  precision: number | null
}

export interface Backtest {
  sample: number
  current: { byTier: TierStats[]; actionable: number; actionableDefects: number }
  proposed: { byTier: TierStats[]; actionable: number; actionableDefects: number }
  missedDefects: number
  newlyCaught: number
}

export interface Metrics {
  precisionByTier: Array<{ tier: number; tierName: string; inspected: number; defects: number; noDefectFound: number; precision: number | null }>
  recall: { confirmedDefects: number; alertedFirst: number; value: number | null }
  alertVolume: { byTier: Array<{ tier: number; tierName: string; alerts: number }>; carPasses: number; per1000CarPasses: number | null }
  ingest: { passes: number; late: number; unresolved: number; awaiting: number; median_lag: number | null; lateAfterMinutes: number }
  open: { work: number; holds: number; alerts: number }
  precisionByKind: Array<{ kind: string; inspected: number; defects: number; precision: number | null }>
  audits: { audits: number; audit_defects: number; open_audits: number; defectRate: number | null }
  lifecycle: Array<{ status: string; n: number; escalated: number; median_ack_min: number | null }>
}
