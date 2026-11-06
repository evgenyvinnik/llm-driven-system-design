/** Shapes returned by the quote API (mirrors backend/src/shared/domain.ts and the route handlers). */

export type Role = 'customer' | 'ops' | 'admin'
export interface User {
  id: string
  username: string
  displayName: string
  role: Role
  customerId: string | null
  customerName: string | null
}

export type Dependency = 'pricing' | 'fuel' | 'capacity' | 'availability'
export const DEPENDENCIES: Dependency[] = ['pricing', 'fuel', 'capacity', 'availability']
export type ClientClass = 'portal' | 'api' | 'api_requote'
export type ComponentSource = 'live' | 'cache' | 'fallback'

export interface PriceComponent {
  component: 'linehaul' | 'fuel_surcharge' | 'capacity_premium' | 'equipment'
  dependency: Dependency
  source: ComponentSource
  amountCentsPerCar: number
  basis: string
  version: string | null
  asOf: string
  ageSeconds: number
  latencyMs: number | null
  staleness: string | null
  detail: Record<string, unknown>
}

export interface QuoteInputs {
  pricingBasis: 'contract' | 'tariff'
  tariffId: string | null
  tariffVersion: number | null
  contractId: string | null
  contractVersion: number | null
  fuelSurchargeDate: string | null
  fuelCentsPerMile: number | null
  capacitySnapshotId: string | null
  availabilitySnapshotId: string | null
  laneMiles: number
  rulesVersion: string
}

export interface Quote {
  id: string
  customerId: string
  customerName?: string
  clientClass: ClientClass
  origin: string
  destination: string
  commodity: string
  equipment: string
  quantity: number
  shipWeek: string
  kind: 'firm' | 'indicative'
  firmStatus: 'not_needed' | 'pending' | 'completed' | 'delayed'
  status: 'open' | 'booked' | 'expired'
  revision: number
  totalCents: number
  currency: string
  band: { lowCents: number; highCents: number }
  components: PriceComponent[]
  inputs: QuoteInputs
  validUntil: string
  bookable: boolean
  createdAt: string
  firmAt: string | null
  latencyMs: number
  correlationId: string
  callback: boolean
  booking: { id: string; honoredTotalCents: number; createdAt: string; currentTariffVersion?: number | null } | null
}

export interface SubmitResult {
  httpStatus: number
  quote: Quote
  firm?: { status: string; poll: string; callback: boolean; unconfirmed: Dependency[] }
  replayed?: boolean
}

export interface StoredEvent {
  position: number
  event_id: string
  type: string
  version: number
  stream_id: string
  stream_version: number
  occurred_at: string
  recorded_at: string
  correlation_id: string
  causation_id: string | null
  producer: string
  payload: Record<string, unknown>
  published_at: string | null
  latestVersion?: number | null
  upcastPayload?: Record<string, unknown> | null
}

export interface Delivery {
  id: string
  event_id: string
  quote_id?: string
  customer_name?: string
  status: 'pending' | 'in_flight' | 'delivered' | 'dead'
  attempts: number
  last_status_code: number | null
  last_error: string | null
  created_at: string
  delivered_at: string | null
  next_attempt_at?: string
}

export interface Reference {
  stations: { code: string; name: string }[]
  lanes: { origin: string; destination: string; miles: number }[]
  commodities: { code: string; stcc: string; name: string; equipment: string[] }[]
  equipment: { code: string; name: string }[]
  shipWeeks: string[]
}

export interface Knobs {
  latencyMs: number
  jitterPct: number
  tailPct: number
  tailMs: number
  errorRate: number
  hangRate: number
  concurrency: number
  down: boolean
}

export interface DepOverview {
  calls: number
  ok: number
  timeout: number
  error: number
  short_circuit: number
  rejected: number
  deadline: number
  cacheHit: number
  cacheMiss: number
  cacheStale: number
  hedgesFired: number
  hedgesWon: number
  hedgesSkipped: number
  coalesced: number
  p50: number | null
  p95: number | null
  p99: number | null
  sampleCount: number
  cacheHitRate: number | null
  breaker: 'closed' | 'open' | 'halfOpen'
  breakers: Record<string, 'closed' | 'open' | 'halfOpen'>
}

export interface ClassOverview {
  firm: number
  indicative: number
  unavailable: number
  shed: number
  rate_limited: number
  replayed: number
  p50: number | null
  p95: number | null
  p99: number | null
}

export interface Settings {
  deadlineMs: number
  budgets: Record<Dependency, number>
  hedging: { enabled: boolean; deps: Dependency[]; percentile: number; minDelayMs: number; budgetPct: number }
  coalescing: boolean
  propagateDeadline: boolean
  shedding: { enabled: boolean; maxInflight: number; thresholds: Record<ClientClass, number> }
  rateLimits: { enabled: boolean; portalPerMinute: number; apiPerMinute: number }
  staleness: { capacityMaxAgeSeconds: number; availabilityMaxAgeSeconds: number }
  validity: { indicativeMinutes: number; firmHours: number }
}

export interface DepServerStats {
  calls: number
  ok: number
  errors: number
  refused: number
  abandoned: number
  wasted: number
  wastedMs: number
  inflight: number
  maxInflight: number
  queued: number
}

export interface OpsOverview {
  instances: { id: string; at: string; inflight: number }[]
  dependencies: Record<Dependency, DepOverview>
  quotes: Record<ClientClass, ClassOverview>
  settings: Settings
  knobs: { knobs: Record<Dependency, Knobs>; defaults: Record<Dependency, Knobs> } | null
  depStats: { stats: Record<Dependency, DepServerStats> } | null
  at: string
}

export interface GroupSummary {
  group: string
  lag: number
  pending: number
  consumers: number
  streams: { stream: string; group: string; consumers: number; pending: number; lag: number | null }[]
}

export interface StreamsOverview {
  groups: GroupSummary[]
  dlqDepth: number
  streamLengths: Record<string, number>
  outbox: { unpublished: number; oldestAgeSeconds: number | null }
  projection: { name: string; eventsApplied: number; lastRecordedAt: string | null; rebuiltAt: string | null; stalenessSeconds: number; updatedAt: string | null } | null
  eventsPerSecond: number
  eventsLastMinute: Record<string, number>
  webhooks: Record<string, number>
}

export interface DeadLetter {
  id: string
  sourceStream: string
  sourceId: string
  group: string
  reason: string
  error: string
  deliveries: number
  deadAt: string
  event: string
  eventType: string | null
  eventId: string | null
}

export interface ReplayResult {
  events: number
  notYetApplied: number
  skipped: { position: number; reason: string }[]
  upcast: number
  maxPosition: number
  diffs: string[]
  match: boolean
  ms: number
}

export interface Receipt {
  eventId: string
  customerId: string
  quoteId: string | null
  totalCents: number | null
  firstReceivedAt: string
  lastReceivedAt: string
  deliveries: number
  attempts: number[]
}

export interface Analytics {
  hourly: { bucket: string; metric: string; dimension: string; value: number }[]
  totals: { metric: string; dimension: string; value: number }[]
  conversion: { requested: number; firmQuotes: number; booked: number; expired: number; rate: number | null }
  latency: { dependency: string; count: number; p50: number | 'inf' | null; p95: number | 'inf' | null; p99: number | 'inf' | null }[]
  sources: { dependency: string; source: string; count: number }[]
  checkpoint: { events_applied: number; rebuilt_at: string | null; updated_at: string } | null
}
