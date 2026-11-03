/**
 * The event contract (schema_version 1). Every producer, the ingest consumer and
 * the tests share this one definition.
 *
 * The schema is strict: an unknown key rejects the event. That is the privacy
 * boundary. A producer that starts attaching `content`, `prompt` or any other
 * field cannot slip it into the pipeline, because nothing downstream ever sees
 * an event that failed validation.
 * @module shared/contract
 */
import { z } from 'zod'

export const FEATURES = ['chat', 'web_search', 'code_execution', 'file_analysis', 'image_input'] as const
export const PLATFORMS = ['web', 'desktop', 'ios', 'android'] as const
export const CLIENT_EVENT_TYPES = ['conversation_started', 'message_sent'] as const
export const SERVER_EVENT_TYPES = ['response_completed', 'response_failed', 'response_abandoned'] as const
export const EVENT_TYPES = [...CLIENT_EVENT_TYPES, ...SERVER_EVENT_TYPES] as const
export const STREAMS = ['client', 'server'] as const

export type Feature = (typeof FEATURES)[number]
export type EventType = (typeof EVENT_TYPES)[number]
export type Stream = (typeof STREAMS)[number]

/** Keys that would mean a producer is leaking conversation content. Reported separately from other schema errors. */
export const CONTENT_KEYS = ['content', 'text', 'prompt', 'message', 'completion', 'response', 'title', 'body', 'attachment']

const isoInstant = z.string().datetime({ offset: true })
const count = z.number().int().nonnegative()

export const chatEventSchema = z
  .object({
    event_id: z.string().uuid(),
    schema_version: z.literal(1),
    event_type: z.enum(EVENT_TYPES),
    source: z.enum(STREAMS),
    org_id: z.string().min(1).max(64),
    /** Pseudonymous, stable per user within an org. Never an email or a name. */
    user_id: z.string().min(1).max(64),
    conversation_id: z.string().min(1).max(64),
    generation_id: z.string().min(1).max(64).optional(),
    /** When it happened, by the producer's clock. Buckets are always by this time. */
    event_time: isoInstant,
    /** When our collector received it. Set server-side; never trusted from a device. */
    received_time: isoInstant,
    model: z.string().min(1).max(64),
    feature: z.enum(FEATURES),
    platform: z.enum(PLATFORMS).optional(),
    ttft_ms: count.max(600_000).optional(),
    latency_ms: count.max(3_600_000).optional(),
    input_tokens: count.max(2_000_000).optional(),
    output_tokens: count.max(2_000_000).optional(),
    error_code: z.string().min(1).max(64).optional(),
    abandon_reason: z.enum(['stop_button', 'disconnect']).optional(),
  })
  .strict()
  .superRefine((ev, ctx) => {
    const isClient = (CLIENT_EVENT_TYPES as readonly string[]).includes(ev.event_type)
    if (isClient !== (ev.source === 'client')) {
      ctx.addIssue({ code: 'custom', path: ['source'], message: `${ev.event_type} must come from the ${isClient ? 'client' : 'server'}` })
    }
    if (!isClient && !ev.generation_id) {
      ctx.addIssue({ code: 'custom', path: ['generation_id'], message: 'response events need a generation_id' })
    }
    if (ev.event_type === 'response_completed') {
      for (const field of ['ttft_ms', 'latency_ms', 'input_tokens', 'output_tokens'] as const) {
        if (ev[field] === undefined) ctx.addIssue({ code: 'custom', path: [field], message: 'required on response_completed' })
      }
    }
    if (ev.event_type === 'response_failed' && !ev.error_code) {
      ctx.addIssue({ code: 'custom', path: ['error_code'], message: 'required on response_failed' })
    }
    if (ev.event_type === 'response_abandoned' && !ev.abandon_reason) {
      ctx.addIssue({ code: 'custom', path: ['abandon_reason'], message: 'required on response_abandoned' })
    }
  })

export type ChatEvent = z.infer<typeof chatEventSchema>

export type ValidationResult =
  | { ok: true; event: ChatEvent }
  | { ok: false; reason: 'invalid_json' | 'content_field' | 'schema'; detail: string }

/** Parses one Kafka message value. Never throws. */
export function validateEvent(raw: string | Buffer | null): ValidationResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(String(raw ?? ''))
  } catch {
    return { ok: false, reason: 'invalid_json', detail: 'value is not JSON' }
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const leaked = Object.keys(parsed).filter((k) => CONTENT_KEYS.includes(k.toLowerCase()))
    if (leaked.length > 0) {
      return { ok: false, reason: 'content_field', detail: `content-like keys: ${leaked.join(', ')}` }
    }
  }
  const result = chatEventSchema.safeParse(parsed)
  if (!result.success) {
    const issue = result.error.issues[0]
    return { ok: false, reason: 'schema', detail: `${issue.path.join('.') || '(root)'}: ${issue.message}` }
  }
  return { ok: true, event: result.data }
}

export function streamOf(eventType: EventType): Stream {
  return (CLIENT_EVENT_TYPES as readonly string[]).includes(eventType) ? 'client' : 'server'
}
