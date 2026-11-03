/**
 * Mock model knobs. Latency and slots are steady settings; failures are
 * "armed" with a count and fire on the next N matching requests, so a demo
 * or test can trigger exactly one mid-stream disconnect or three overloads
 * in a row on demand, which a real provider can't do.
 * @module model/settings
 */
import { z } from 'zod'

export const CHAOS_KINDS = [
  'overloaded',
  'rate_limited',
  'midstream_disconnect',
  'max_tokens_text',
  'max_tokens_tool',
  'invalid_tool_name',
  'invalid_args',
  'repeat_call',
  'refusal',
] as const
export type ChaosKind = (typeof CHAOS_KINDS)[number]

export interface MockSettings {
  ttftMs: number
  tokensPerSecond: number
  maxConcurrent: number
  /** A gullible model obeys instructions found inside emails; the policy engine has to stop it. */
  followInjectedInstructions: boolean
  chaos: Record<ChaosKind, number>
}

export function defaultSettings(): MockSettings {
  return {
    ttftMs: Number(process.env.MOCK_TTFT_MS ?? 350),
    tokensPerSecond: Number(process.env.MOCK_TOKENS_PER_SECOND ?? 80),
    maxConcurrent: 16,
    followInjectedInstructions: process.env.MOCK_FOLLOW_INJECTIONS !== 'false',
    chaos: Object.fromEntries(CHAOS_KINDS.map((k) => [k, 0])) as Record<ChaosKind, number>,
  }
}

export const settingsPatchSchema = z
  .object({
    ttftMs: z.number().int().min(0).max(10_000),
    tokensPerSecond: z.number().int().min(1).max(2000),
    maxConcurrent: z.number().int().min(1).max(256),
    followInjectedInstructions: z.boolean(),
    chaos: z.record(z.enum(CHAOS_KINDS), z.number().int().min(0).max(20)),
  })
  .partial()
