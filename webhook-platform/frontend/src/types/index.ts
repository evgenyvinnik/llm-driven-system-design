export type Role = 'customer' | 'operator'

export interface User {
  id: string
  username: string
  displayName: string
  role: Role
  orgId: string | null
  orgName: string | null
}

export type DeliveryState = 'queued' | 'in_flight' | 'scheduled' | 'delivered' | 'failed'

export interface EndpointHealth {
  inFlight: number
  waiting: number
  failed: number
  delivered: number
  attempts1h: number
  successRate1h: number | null
  p50Ms: number | null
  p95Ms: number | null
  probing: boolean
  effectiveConcurrency: number
}

export interface Endpoint {
  id: string
  url: string
  description: string
  eventTypes: string[]
  status: 'active' | 'disabled'
  disabledReason: string | null
  disabledAt: string | null
  maxConcurrency: number
  secretHint: string
  rotation: { previousExpiresAt: string } | null
  secretRotatedAt: string | null
  consecutiveFailures: number
  failingSince: string | null
  lastSuccessAt: string | null
  lastFailureAt: string | null
  pausedUntil: string | null
  createdAt: string
  health: EndpointHealth
}

export interface EventItem {
  id: string
  type: string
  data: Record<string, unknown>
  orderingKey: string | null
  sequence: number | null
  idempotencyKey: string
  source: 'api' | 'console'
  createdAt: string
  deliveries?: { total: number; delivered: number; failed: number; pending: number }
}

export interface Delivery {
  id: string
  eventId: string
  endpointId: string
  state: DeliveryState
  attemptCount: number
  replayCount: number
  nextAttemptAt: string | null
  retryDeadline: string | null
  firstAttemptAt: string | null
  lastAttemptAt: string | null
  deliveredAt: string | null
  lastStatusCode: number | null
  lastErrorClass: string | null
  parkCount: number
  createdAt: string
  eventType: string | null
  endpointUrl: string | null
  endpointDescription: string | null
  orderingKey: string | null
  sequence: number | null
  endpointStatus?: string
}

export interface Attempt {
  id: number
  attemptNo: number
  trigger: 'initial' | 'retry' | 'replay' | 'recovered'
  startedAt: string
  latencyMs: number | null
  statusCode: number | null
  errorClass: string
  errorMessage: string | null
  responseBody: string | null
  outcome: 'delivered' | 'retry' | 'failed' | 'superseded' | 'lost'
  nextAttemptAt: string | null
  workerId: string | null
  resolvedIp: string | null
  signaturesSent: number
}

export interface NotificationItem {
  id: number
  endpointId: string | null
  kind: string
  title: string
  body: string
  createdAt: string
  readAt: string | null
}

export type ReceiverMode = 'ok' | 'slow' | 'error500' | 'drop_ack' | 'gone410' | 'rate429'

export interface ReceiverPath {
  name: string
  endpointId: string
  description: string
  status: string
  config: { name: string; mode: ReceiverMode; remaining: number | null; slowMs: number; retryAfterSeconds: number; pinnedSecrets: number | null }
}

export interface ReceivedEntry {
  seq: number
  path: string
  receivedAt: string
  eventId: string | null
  deliveryId: string | null
  type: string | null
  attempt: number | null
  orderingKey: string | null
  sequence: number | null
  signatureValid: boolean | null
  signatureReason: string | null
  signaturesPresented: number
  duplicate: boolean
  stale: boolean
  processed: boolean
  fault: ReceiverMode
  responseStatus: number | null
  note: string
}

export interface ReceiverStats {
  requests: number
  processed: number
  uniqueEvents: number
  duplicates: number
  badSignatures: number
  stale: number
}

export interface ReceiverView {
  receiverUrl: string
  paths: ReceiverPath[]
  received: ReceivedEntry[]
  stats: ReceiverStats | null
}

export interface QueueInfo {
  name: string
  ready: number | null
  unacked: number | null
  consumers: number | null
  publishRate: number | null
  deliverRate: number | null
  redeliverRate: number | null
}

export interface OpsOverview {
  queue: QueueInfo
  poison: QueueInfo
  outbox: { unpublished: number; oldestSeconds: number | null }
  deliveriesByState: Record<string, number>
  successRate5m: number | null
  attempts5m: number
  orgs: {
    org: string
    attempts5m: number
    successRate5m: number | null
    attemptP50Ms: number | null
    attemptP95Ms: number | null
    eventToDeliveredP50Ms: number | null
    eventToDeliveredP95Ms: number | null
  }[]
  endpoints: {
    id: string
    org: string
    description: string
    url: string
    status: string
    maxConcurrency: number
    effectiveConcurrency: number
    consecutiveFailures: number
    pausedUntil: string | null
    inFlight: number
    slotsHeld: number | null
    queued: number
    scheduled: number
  }[]
  policy: { retryHorizonSeconds: number; backoffBaseMs: number; backoffCapMs: number; timeoutMs: number; probeAfterFailures: number }
}
