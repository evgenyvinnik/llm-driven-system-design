/**
 * Row types and their camelCase DTOs. Handlers never return raw rows.
 * @module api/services/dto
 */

export interface EventRow {
  id: string
  org_id: string
  type: string
  payload: Record<string, unknown>
  ordering_key: string | null
  sequence: string | null
  idempotency_key: string
  request_hash: string
  source: 'api' | 'console'
  created_at: Date
}

export interface EventDto {
  id: string
  type: string
  data: Record<string, unknown>
  orderingKey: string | null
  sequence: number | null
  idempotencyKey: string
  source: 'api' | 'console'
  createdAt: string
}

export function toEventDto(r: EventRow): EventDto {
  return {
    id: r.id,
    type: r.type,
    data: r.payload,
    orderingKey: r.ordering_key,
    sequence: r.sequence === null ? null : Number(r.sequence),
    idempotencyKey: r.idempotency_key,
    source: r.source,
    createdAt: r.created_at.toISOString(),
  }
}

export interface EndpointRow {
  id: string
  org_id: string
  url: string
  description: string
  event_types: string[]
  status: 'active' | 'disabled'
  disabled_reason: string | null
  disabled_at: Date | null
  max_concurrency: number
  secret_current: string
  secret_previous: string | null
  previous_expires_at: Date | null
  secret_rotated_at: Date | null
  consecutive_failures: number
  failing_since: Date | null
  last_success_at: Date | null
  last_failure_at: Date | null
  paused_until: Date | null
  created_at: Date
  updated_at: Date
}

const iso = (d: Date | null) => (d ? d.toISOString() : null)

export function toEndpointDto(r: EndpointRow) {
  const now = Date.now()
  return {
    id: r.id,
    url: r.url,
    description: r.description,
    eventTypes: r.event_types,
    status: r.status,
    disabledReason: r.disabled_reason,
    disabledAt: iso(r.disabled_at),
    maxConcurrency: r.max_concurrency,
    secretHint: `${r.secret_current.slice(0, 10)}…`,
    rotation: r.secret_previous && r.previous_expires_at && r.previous_expires_at.getTime() > now ? { previousExpiresAt: iso(r.previous_expires_at) } : null,
    secretRotatedAt: iso(r.secret_rotated_at),
    consecutiveFailures: r.consecutive_failures,
    failingSince: iso(r.failing_since),
    lastSuccessAt: iso(r.last_success_at),
    lastFailureAt: iso(r.last_failure_at),
    pausedUntil: r.paused_until && r.paused_until.getTime() > now ? iso(r.paused_until) : null,
    createdAt: iso(r.created_at),
  }
}

export interface DeliveryRow {
  id: string
  event_id: string
  endpoint_id: string
  org_id: string
  state: 'queued' | 'in_flight' | 'scheduled' | 'delivered' | 'failed'
  dispatch_seq: number
  attempt_count: number
  replay_count: number
  next_attempt_at: Date | null
  retry_deadline: Date
  window_started_at: Date | null
  queued_at: Date | null
  lease_token: string | null
  lease_until: Date | null
  claimed_by: string | null
  first_attempt_at: Date | null
  last_attempt_at: Date | null
  delivered_at: Date | null
  last_status_code: number | null
  last_error_class: string | null
  park_count: number
  created_at: Date
  updated_at: Date
}

export function toDeliveryDto(r: DeliveryRow & { event_type?: string; endpoint_url?: string; endpoint_description?: string; ordering_key?: string | null; sequence?: string | null }) {
  return {
    id: r.id,
    eventId: r.event_id,
    endpointId: r.endpoint_id,
    state: r.state,
    attemptCount: r.attempt_count,
    replayCount: r.replay_count,
    nextAttemptAt: iso(r.next_attempt_at),
    retryDeadline: iso(r.retry_deadline),
    firstAttemptAt: iso(r.first_attempt_at),
    lastAttemptAt: iso(r.last_attempt_at),
    deliveredAt: iso(r.delivered_at),
    lastStatusCode: r.last_status_code,
    lastErrorClass: r.last_error_class,
    parkCount: r.park_count,
    createdAt: iso(r.created_at),
    eventType: r.event_type ?? null,
    endpointUrl: r.endpoint_url ?? null,
    endpointDescription: r.endpoint_description ?? null,
    orderingKey: r.ordering_key ?? null,
    sequence: r.sequence === undefined || r.sequence === null ? null : Number(r.sequence),
  }
}

export interface AttemptRow {
  id: string
  delivery_id: string
  attempt_no: number
  trigger: string
  started_at: Date
  latency_ms: number | null
  status_code: number | null
  error_class: string
  error_message: string | null
  response_body: string | null
  outcome: string
  next_attempt_at: Date | null
  worker_id: string | null
  resolved_ip: string | null
  signatures_sent: number
}

export function toAttemptDto(r: AttemptRow) {
  return {
    id: Number(r.id),
    attemptNo: r.attempt_no,
    trigger: r.trigger,
    startedAt: iso(r.started_at),
    latencyMs: r.latency_ms,
    statusCode: r.status_code,
    errorClass: r.error_class,
    errorMessage: r.error_message,
    responseBody: r.response_body,
    outcome: r.outcome,
    nextAttemptAt: iso(r.next_attempt_at),
    workerId: r.worker_id,
    resolvedIp: r.resolved_ip,
    signaturesSent: r.signatures_sent,
  }
}
