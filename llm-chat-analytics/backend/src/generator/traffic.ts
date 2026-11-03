/**
 * Deterministic chat-traffic model. Given an org and one minute, it returns
 * every event of the conversations that start in that minute. The same inputs
 * always produce the same events and the same event_ids, so history can be
 * regenerated exactly and a re-run of the seed is caught by dedup.
 * @module generator/traffic
 */
import { createHash } from 'node:crypto'
import type { ChatEvent, Feature } from '../shared/contract.js'
import { FEATURES } from '../shared/contract.js'
import { DAY, HOUR, MINUTE } from '../shared/time.js'
import { DIURNAL, ERROR_CODES, FEATURE_WEIGHTS, MODELS, type ModelProfile, type OrgProfile } from './profiles.js'

export interface Incident {
  start: number
  end: number
  model: string
  extraErrorRate: number
  ttftFactor: number
}

export interface TrafficOptions {
  /** Abandoned generations are only reported from this instant on (the metric's collection start). */
  abandonTrackedFrom: number
  incidents: Incident[]
  /** Reference "now" for the code-execution launch ramp. */
  anchor: number
}

/** An event plus the network delay between it happening and the collector receiving it. */
export interface GeneratedEvent {
  event: Omit<ChatEvent, 'received_time'>
  deliveryDelayMs: number
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hashInt(input: string): number {
  return createHash('sha1').update(input).digest().readUInt32BE(0)
}

/** Deterministic UUID (version nibble 5) from a name. */
export function deterministicUuid(name: string): string {
  const h = createHash('sha1').update(name).digest('hex')
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`
}

export function pseudonymousUserId(orgId: string, index: number): string {
  return `u_${createHash('sha1').update(`${orgId}:user:${index}`).digest('hex').slice(0, 12)}`
}

function poisson(lambda: number, rnd: () => number): number {
  if (lambda <= 0) return 0
  const l = Math.exp(-lambda)
  let k = 0
  let p = 1
  do {
    k++
    p *= rnd()
  } while (p > l && k < 500)
  return k - 1
}

/** Log-normal sample with the given median. */
function logNormal(median: number, sigma: number, rnd: () => number): number {
  const u1 = Math.max(rnd(), 1e-9)
  const u2 = rnd()
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
  return median * Math.exp(sigma * z)
}

function pickWeighted<T>(items: T[], weight: (item: T) => number, rnd: () => number): T {
  const total = items.reduce((s, i) => s + weight(i), 0)
  let r = rnd() * total
  for (const item of items) {
    r -= weight(item)
    if (r <= 0) return item
  }
  return items[items.length - 1]
}

const localParts = new Map<string, Intl.DateTimeFormat>()
function localHourAndWeekday(instant: number, timeZone: string): { hour: number; weekend: boolean } {
  let fmt = localParts.get(timeZone)
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23', weekday: 'short' })
    localParts.set(timeZone, fmt)
  }
  const parts = fmt.formatToParts(instant)
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0)
  const weekday = parts.find((p) => p.type === 'weekday')?.value ?? 'Mon'
  return { hour, weekend: weekday === 'Sat' || weekday === 'Sun' }
}

function featureWeight(feature: Feature, t: number, anchor: number): number {
  const base = FEATURE_WEIGHTS[feature]
  if (feature !== 'code_execution') return base
  // Code execution launched about a month ago and adoption ramps over three weeks.
  const ramp = (t - (anchor - 30 * DAY)) / (21 * DAY)
  return base * Math.min(1, Math.max(0.12, ramp))
}

/** Expected conversations starting in this minute for the org. */
export function conversationRate(org: OrgProfile, minuteStart: number): number {
  const { hour, weekend } = localHourAndWeekday(minuteStart, org.timeZone)
  const perDay = org.users * org.conversationsPerUserDay * (weekend ? org.weekendFactor : 1)
  return (perDay * DIURNAL[hour]) / 60
}

export function generateMinute(org: OrgProfile, minuteStart: number, opts: TrafficOptions): GeneratedEvent[] {
  const rnd = mulberry32(hashInt(`${org.id}:${minuteStart}`))
  const n = poisson(conversationRate(org, minuteStart), rnd)
  const out: GeneratedEvent[] = []

  for (let c = 0; c < n; c++) {
    const name = `${org.id}:${minuteStart}:${c}`
    const userIndex = Math.floor(org.users * Math.pow(rnd(), 1.5))
    const userId = pseudonymousUserId(org.id, userIndex)
    const platformRoll = hashInt(userId) % 100
    const platform = platformRoll < 50 ? 'web' : platformRoll < 75 ? 'desktop' : platformRoll < 90 ? 'ios' : 'android'
    const model: ModelProfile = pickWeighted(MODELS, (m) => m.share, rnd)
    const conversationId = `c_${createHash('sha1').update(name).digest('hex').slice(0, 16)}`
    let t = minuteStart + Math.floor(rnd() * MINUTE)
    const clientDelay = () => Math.round(logNormal(250, 0.8, rnd))
    const serverDelay = () => Math.round(5 + rnd() * 40)

    const base = {
      schema_version: 1 as const,
      org_id: org.id,
      user_id: userId,
      conversation_id: conversationId,
      model: model.id,
    }

    out.push({
      event: { ...base, event_id: deterministicUuid(`${name}:start`), event_type: 'conversation_started', source: 'client', feature: 'chat', platform, event_time: new Date(t).toISOString() },
      deliveryDelayMs: clientDelay(),
    })

    const messages = Math.min(12, 1 + Math.floor(-Math.log(Math.max(rnd(), 1e-9)) * 2.2))
    for (let m = 0; m < messages; m++) {
      t += m === 0 ? 2000 + Math.floor(rnd() * 15_000) : 25_000 + Math.floor(rnd() * 150_000)
      const feature: Feature =
        m === 0 && rnd() < 0.5 ? 'chat' : pickWeighted([...FEATURES], (f) => featureWeight(f, t, opts.anchor), rnd)
      const msgName = `${name}:m${m}`
      out.push({
        event: { ...base, event_id: deterministicUuid(`${msgName}:sent`), event_type: 'message_sent', source: 'client', feature, platform, event_time: new Date(t).toISOString() },
        deliveryDelayMs: clientDelay(),
      })

      const incident = opts.incidents.find((i) => i.model === model.id && t >= i.start && t < i.end)
      const generationId = `g_${createHash('sha1').update(msgName).digest('hex').slice(0, 16)}`
      const inputTokens = Math.round(120 + 380 * m + logNormal(220, 0.6, rnd))
      const roll = rnd()
      const failRate = 0.022 + (incident?.extraErrorRate ?? 0)
      const abandonRate = 0.045
      const ttft = Math.round(logNormal(model.ttftMedianMs * (incident?.ttftFactor ?? 1), 0.45, rnd))
      const fullOutput = Math.min(4000, Math.round(logNormal(feature === 'code_execution' ? 520 : 280, 0.7, rnd)))
      const response = { ...base, generation_id: generationId, source: 'server' as const, feature }

      if (roll < failRate) {
        const at = t + 400 + Math.floor(rnd() * (incident ? 28_000 : 8000))
        out.push({
          event: {
            ...response,
            event_id: deterministicUuid(`${msgName}:failed`),
            event_type: 'response_failed',
            event_time: new Date(at).toISOString(),
            error_code: incident ? (rnd() < 0.7 ? 'overloaded' : 'timeout') : ERROR_CODES[Math.floor(rnd() * ERROR_CODES.length)],
            input_tokens: inputTokens,
            output_tokens: 0,
          },
          deliveryDelayMs: serverDelay(),
        })
        t = at
      } else if (roll < failRate + abandonRate) {
        const partial = Math.round(fullOutput * rnd() * 0.6)
        const at = t + ttft + Math.round((partial / model.tokensPerSecond) * 1000)
        if (at >= opts.abandonTrackedFrom) {
          out.push({
            event: {
              ...response,
              event_id: deterministicUuid(`${msgName}:abandoned`),
              event_type: 'response_abandoned',
              event_time: new Date(at).toISOString(),
              abandon_reason: rnd() < 0.7 ? 'stop_button' : 'disconnect',
              input_tokens: inputTokens,
              output_tokens: partial,
            },
            deliveryDelayMs: serverDelay(),
          })
        }
        t = at
      } else {
        const latency = ttft + Math.round((fullOutput / model.tokensPerSecond) * 1000)
        const at = t + latency
        out.push({
          event: {
            ...response,
            event_id: deterministicUuid(`${msgName}:completed`),
            event_type: 'response_completed',
            event_time: new Date(at).toISOString(),
            ttft_ms: ttft,
            latency_ms: latency,
            input_tokens: inputTokens,
            output_tokens: fullOutput,
          },
          deliveryDelayMs: serverDelay(),
        })
        t = at
      }
    }
  }
  return out
}

/** Incidents placed relative to `now`, so a fresh seed always has one inside the last week. */
export function defaultIncidents(now: number): Incident[] {
  const dayStart = Math.floor(now / DAY) * DAY - 5 * DAY
  return [{ start: dayStart + 17 * HOUR, end: dayStart + 19 * HOUR, model: 'orion-large', extraErrorRate: 0.16, ttftFactor: 3.2 }]
}
