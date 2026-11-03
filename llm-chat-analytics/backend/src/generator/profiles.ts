/**
 * Fictitious orgs, models and features for the simulated chat product. The
 * seed writes the orgs and prices to PostgreSQL from this file, and the
 * generator draws traffic from it, so both always agree.
 * @module generator/profiles
 */
import type { Feature } from '../shared/contract.js'

export interface OrgProfile {
  id: string
  name: string
  timeZone: string
  users: number
  /** Conversations per user per weekday at full activity. */
  conversationsPerUserDay: number
  weekendFactor: number
}

export const ORGS: OrgProfile[] = [
  // Large org on US Pacific time (DST changes on the first Sunday of November).
  { id: 'larkspur', name: 'Larkspur Labs', timeZone: 'America/Los_Angeles', users: 900, conversationsPerUserDay: 1.1, weekendFactor: 0.3 },
  // Half-hour offset zone: local midnight is 18:30 UTC, so local days never align with UTC hours.
  { id: 'kestrel', name: 'Kestrel Health', timeZone: 'Asia/Kolkata', users: 320, conversationsPerUserDay: 1.0, weekendFactor: 0.45 },
  { id: 'fjordline', name: 'Fjordline Systems', timeZone: 'Europe/Berlin', users: 160, conversationsPerUserDay: 1.3, weekendFactor: 0.2 },
  // Four people: every breakdown and drill-down here falls under the small-cohort threshold.
  { id: 'atelier', name: 'Tiny Atelier', timeZone: 'Pacific/Auckland', users: 4, conversationsPerUserDay: 2.5, weekendFactor: 0.6 },
]

export interface ModelProfile {
  id: string
  share: number
  ttftMedianMs: number
  tokensPerSecond: number
  inputMicrosPerMTok: number
  outputMicrosPerMTok: number
}

export const MODELS: ModelProfile[] = [
  { id: 'orion-swift', share: 0.55, ttftMedianMs: 380, tokensPerSecond: 95, inputMicrosPerMTok: 800_000, outputMicrosPerMTok: 4_000_000 },
  { id: 'orion-large', share: 0.35, ttftMedianMs: 760, tokensPerSecond: 48, inputMicrosPerMTok: 3_000_000, outputMicrosPerMTok: 15_000_000 },
  { id: 'orion-think', share: 0.1, ttftMedianMs: 2600, tokensPerSecond: 40, inputMicrosPerMTok: 6_000_000, outputMicrosPerMTok: 30_000_000 },
]

export const FEATURE_WEIGHTS: Record<Feature, number> = {
  chat: 0.6,
  web_search: 0.15,
  code_execution: 0.09,
  file_analysis: 0.11,
  image_input: 0.05,
}

/** Share of a weekday's conversations started in each local hour (sums to 1). */
export const DIURNAL: number[] = (() => {
  const raw = [0.2, 0.12, 0.08, 0.06, 0.06, 0.1, 0.3, 0.7, 1.2, 1.6, 1.8, 1.75, 1.4, 1.6, 1.75, 1.7, 1.5, 1.2, 0.9, 0.7, 0.6, 0.5, 0.4, 0.3]
  const total = raw.reduce((a, b) => a + b, 0)
  return raw.map((v) => v / total)
})()

export const ERROR_CODES = ['overloaded', 'timeout', 'internal', 'context_length']
