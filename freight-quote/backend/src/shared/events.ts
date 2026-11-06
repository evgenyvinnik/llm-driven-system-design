/**
 * Domain events: the envelope, a versioned zod schema per event type, and the
 * upcasters that let consumers read old versions as the latest one.
 *
 * Writers always emit the latest version. Readers call `parseEvent`, which
 * validates the stored version and upcasts it step by step, so a consumer
 * only ever handles one shape per type. Consumers are deployed before
 * producers when a version is added (tolerant reader first).
 * @module shared/events
 */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'

export const EVENT_TYPES = [
  'QuoteRequested',
  'QuoteIssued',
  'FirmQuoteCompleted',
  'QuoteExpired',
  'QuoteBooked',
  'TariffPublished',
  'FuelSurchargeChanged',
  'DependencyCircuitOpened',
  'DependencyCircuitClosed',
] as const
export type EventType = (typeof EVENT_TYPES)[number]

const iso = z.string().min(10)
const dependency = z.enum(['pricing', 'fuel', 'capacity', 'availability'])
const clientClass = z.enum(['portal', 'api', 'api_requote'])
const kind = z.enum(['firm', 'indicative'])

const quoteRequestedV1 = z.object({
  quote_id: z.string().uuid(),
  customer_id: z.string(),
  client_class: clientClass,
  origin: z.string(),
  destination: z.string(),
  commodity: z.string(),
  equipment: z.string(),
  quantity: z.number().int().positive(),
  ship_week: z.string(),
  idempotency_key: z.string(),
  deadline_ms: z.number().int(),
  /** False when the synchronous path already produced a firm quote. */
  needs_firm: z.boolean(),
})

const quoteIssuedV1 = z.object({
  quote_id: z.string().uuid(),
  customer_id: z.string(),
  kind,
  revision: z.number().int().positive(),
  total_cents: z.number().int(),
  currency: z.string(),
  valid_until: iso,
  tariff_version: z.string().nullable(),
  surcharge_date: z.string().nullable(),
})

export const priceComponentProvenance = z.object({
  component: z.string(),
  dependency,
  source: z.enum(['live', 'cache', 'fallback', 'unknown']),
  version: z.string().nullable(),
  as_of: z.string().nullable(),
  age_seconds: z.number().nullable(),
  latency_ms: z.number().nullable(),
  amount_cents_per_car: z.number().int().nullable(),
})
export type PriceComponentProvenance = z.infer<typeof priceComponentProvenance>

/** v2 adds per-component provenance (source, version, age, latency) and why the quote was (re)issued. */
const quoteIssuedV2 = quoteIssuedV1.extend({
  reason: z.enum(['initial', 'firm_completed', 'repriced_tariff', 'repriced_fuel', 'unknown']),
  client_class: clientClass.nullable(),
  latency_ms: z.number().int().nullable(),
  price_components: z.array(priceComponentProvenance),
})

const firmQuoteCompletedV1 = z.object({
  quote_id: z.string().uuid(),
  customer_id: z.string(),
  total_cents: z.number().int(),
  indicative_total_cents: z.number().int(),
  valid_until: iso,
  tariff_version: z.string().nullable(),
  surcharge_date: z.string().nullable(),
  attempts: z.number().int().positive(),
  /** Event time from QuoteRequested to firm, in ms. */
  completion_ms: z.number().int().nonnegative(),
})

const quoteExpiredV1 = z.object({
  quote_id: z.string().uuid(),
  customer_id: z.string(),
  kind,
  valid_until: iso,
})

const quoteBookedV1 = z.object({
  quote_id: z.string().uuid(),
  booking_id: z.string().uuid(),
  customer_id: z.string(),
  kind,
  honored_total_cents: z.number().int(),
  honored_tariff_version: z.string().nullable(),
  current_tariff_version: z.string().nullable(),
})

const tariffPublishedV1 = z.object({
  tariff_id: z.string(),
  origin: z.string(),
  destination: z.string(),
  commodity: z.string(),
  equipment: z.string(),
  version: z.number().int().positive(),
  rate_per_car_cents: z.number().int().positive(),
  effective_at: iso,
})

const fuelSurchargeChangedV1 = z.object({
  effective_date: z.string(),
  /** Publication time; orders two publications for the same week (a correction). */
  published_at: iso,
  cents_per_mile: z.number().positive(),
  previous_cents_per_mile: z.number().nullable(),
})

const circuitOpenedV1 = z.object({
  dependency,
  instance_id: z.string(),
  reason: z.string(),
})

const circuitClosedV1 = z.object({
  dependency,
  instance_id: z.string(),
  open_ms: z.number().int().nonnegative().nullable(),
})

/** Every (type, version) the system can read. */
export const SCHEMAS = {
  QuoteRequested: { 1: quoteRequestedV1 },
  QuoteIssued: { 1: quoteIssuedV1, 2: quoteIssuedV2 },
  FirmQuoteCompleted: { 1: firmQuoteCompletedV1 },
  QuoteExpired: { 1: quoteExpiredV1 },
  QuoteBooked: { 1: quoteBookedV1 },
  TariffPublished: { 1: tariffPublishedV1 },
  FuelSurchargeChanged: { 1: fuelSurchargeChangedV1 },
  DependencyCircuitOpened: { 1: circuitOpenedV1 },
  DependencyCircuitClosed: { 1: circuitClosedV1 },
} as const satisfies Record<EventType, Record<number, z.ZodTypeAny>>

/** The latest payload shape of each type: what consumers see after upcasting. */
export interface PayloadMap {
  QuoteRequested: z.infer<typeof quoteRequestedV1>
  QuoteIssued: z.infer<typeof quoteIssuedV2>
  FirmQuoteCompleted: z.infer<typeof firmQuoteCompletedV1>
  QuoteExpired: z.infer<typeof quoteExpiredV1>
  QuoteBooked: z.infer<typeof quoteBookedV1>
  TariffPublished: z.infer<typeof tariffPublishedV1>
  FuelSurchargeChanged: z.infer<typeof fuelSurchargeChangedV1>
  DependencyCircuitOpened: z.infer<typeof circuitOpenedV1>
  DependencyCircuitClosed: z.infer<typeof circuitClosedV1>
}
export type PayloadOf<T extends EventType> = PayloadMap[T]
export type QuoteIssuedV1Payload = z.infer<typeof quoteIssuedV1>

export const LATEST_VERSION: Record<EventType, number> = {
  QuoteRequested: 1,
  QuoteIssued: 2,
  FirmQuoteCompleted: 1,
  QuoteExpired: 1,
  QuoteBooked: 1,
  TariffPublished: 1,
  FuelSurchargeChanged: 1,
  DependencyCircuitOpened: 1,
  DependencyCircuitClosed: 1,
}

type Upcaster = (payload: Record<string, unknown>) => Record<string, unknown>

/**
 * Upcasters, keyed by type and the version they upgrade FROM. A v1
 * QuoteIssued carried only flat version fields; v2 readers get a synthesized
 * provenance list with source "unknown" and null latencies, which the
 * analytics projection skips when computing dependency latency.
 */
export const UPCASTERS: Partial<Record<EventType, Record<number, Upcaster>>> = {
  QuoteIssued: {
    1: (p) => ({
      ...p,
      reason: 'unknown',
      client_class: null,
      latency_ms: null,
      price_components: [
        {
          component: 'linehaul',
          dependency: 'pricing',
          source: 'unknown',
          version: (p.tariff_version as string | null) ?? null,
          as_of: null,
          age_seconds: null,
          latency_ms: null,
          amount_cents_per_car: null,
        },
        {
          component: 'fuel_surcharge',
          dependency: 'fuel',
          source: 'unknown',
          version: p.surcharge_date ? `fsc:${p.surcharge_date as string}` : null,
          as_of: null,
          age_seconds: null,
          latency_ms: null,
          amount_cents_per_car: null,
        },
      ],
    }),
  },
}

export const envelopeSchema = z.object({
  event_id: z.string().uuid(),
  type: z.string(),
  version: z.number().int().positive(),
  occurred_at: iso,
  recorded_at: iso,
  stream_id: z.string().min(1),
  stream_version: z.number().int().nonnegative().nullable(),
  correlation_id: z.string(),
  causation_id: z.string().nullable(),
  producer: z.string(),
  payload: z.record(z.unknown()),
})
export type RawEnvelope = z.infer<typeof envelopeSchema>

export interface DomainEvent<T extends EventType = EventType> extends Omit<RawEnvelope, 'type' | 'payload'> {
  type: T
  payload: PayloadOf<T>
  /** The version the event was stored as, before upcasting. */
  storedVersion: number
}

/** Discriminated union over every event type, so `switch (event.type)` narrows the payload. */
export type AnyDomainEvent = { [K in EventType]: DomainEvent<K> }[EventType]

export class UnknownSchemaError extends Error {
  readonly permanent = true
  constructor(message: string) {
    super(message)
    this.name = 'UnknownSchemaError'
  }
}

export class InvalidEventError extends Error {
  readonly permanent = true
  constructor(message: string) {
    super(message)
    this.name = 'InvalidEventError'
  }
}

export function isEventType(type: string): type is EventType {
  return (EVENT_TYPES as readonly string[]).includes(type)
}

/** Validates an envelope and its payload, then upcasts the payload to the latest version. */
export function parseEvent(raw: unknown): AnyDomainEvent {
  const env = envelopeSchema.safeParse(raw)
  if (!env.success) throw new InvalidEventError(`bad envelope: ${env.error.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; ')}`)
  const { type, version } = env.data
  if (!isEventType(type)) throw new UnknownSchemaError(`unknown event type ${type}`)
  const versions = SCHEMAS[type] as Record<number, z.ZodTypeAny>
  const schema = versions[version]
  if (!schema) throw new UnknownSchemaError(`unknown version ${type} v${version}`)
  const parsed = schema.safeParse(env.data.payload)
  if (!parsed.success) throw new InvalidEventError(`bad ${type} v${version} payload: ${parsed.error.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; ')}`)

  let payload = parsed.data as Record<string, unknown>
  for (let v = version; v < LATEST_VERSION[type]; v += 1) {
    const up = UPCASTERS[type]?.[v]
    if (!up) throw new UnknownSchemaError(`no upcaster for ${type} v${v}`)
    payload = (versions[v + 1] as z.ZodTypeAny).parse(up(payload)) as Record<string, unknown>
  }
  return { ...env.data, type, version: LATEST_VERSION[type], storedVersion: version, payload } as AnyDomainEvent
}

export interface NewEvent<T extends EventType = EventType> {
  type: T
  streamId: string
  payload: PayloadOf<T>
  correlationId: string
  causationId?: string | null
  occurredAt?: Date
  /** Defaults to the latest version. Only the seed writes older versions (pre-migration history). */
  version?: number
  eventId?: string
}

/** Builds a full envelope. `stream_version` is assigned by the event store when appended. */
export function buildEnvelope(event: NewEvent, producer: string, recordedAt = new Date()): RawEnvelope {
  const version = event.version ?? LATEST_VERSION[event.type]
  const schema = (SCHEMAS[event.type] as Record<number, z.ZodTypeAny>)[version]
  if (!schema) throw new UnknownSchemaError(`cannot write ${event.type} v${version}`)
  schema.parse(event.payload)
  return {
    event_id: event.eventId ?? randomUUID(),
    type: event.type,
    version,
    occurred_at: (event.occurredAt ?? recordedAt).toISOString(),
    recorded_at: recordedAt.toISOString(),
    stream_id: event.streamId,
    stream_version: null,
    correlation_id: event.correlationId,
    causation_id: event.causationId ?? null,
    producer,
    payload: event.payload as Record<string, unknown>,
  }
}

export const quoteStream = (quoteId: string) => `quote-${quoteId}`
export const tariffStream = (origin: string, destination: string, commodity: string, equipment: string) =>
  `tariff-${origin}-${destination}-${commodity}-${equipment}`
export const fuelStream = () => 'fuel-surcharge'
export const dependencyStream = (dep: string) => `dependency-${dep}`
