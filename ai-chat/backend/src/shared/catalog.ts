/**
 * Model catalog shared by the API (validation, /models), the executor (context
 * budget), and the mock model service (latency and failure behavior). The ids
 * are simulated models; no real provider is called.
 * @module shared/catalog
 */

export interface ModelSpec {
  id: string
  label: string
  description: string
  /** Prompt budget in estimated tokens; older messages beyond it are dropped from the context. */
  contextTokens: number
  maxOutputTokens: number
  /** Simulated time to first token. */
  ttftMs: number
  tokensPerSecond: number
  /** Probability that a generation fails partway through with an error event. */
  failureRate: number
  style: 'concise' | 'thorough'
}

export const MODELS: readonly ModelSpec[] = [
  {
    id: 'sim-swift',
    label: 'Sim Swift',
    description: 'Quick conversational answers at about 60 tokens/s',
    contextTokens: 3000,
    maxOutputTokens: 600,
    ttftMs: 300,
    tokensPerSecond: 60,
    failureRate: 0,
    style: 'concise',
  },
  {
    id: 'sim-deep',
    label: 'Sim Deep',
    description: 'Longer answers with headings, lists, tables and code at about 25 tokens/s',
    contextTokens: 6000,
    maxOutputTokens: 1200,
    ttftMs: 900,
    tokensPerSecond: 25,
    failureRate: 0,
    style: 'thorough',
  },
  {
    id: 'sim-flaky',
    label: 'Sim Flaky',
    description: 'Fails partway through about one answer in three, for exercising error paths',
    contextTokens: 3000,
    maxOutputTokens: 600,
    ttftMs: 400,
    tokensPerSecond: 40,
    failureRate: 0.35,
    style: 'concise',
  },
]

export const MODEL_IDS = MODELS.map((m) => m.id) as [string, ...string[]]
export const DEFAULT_MODEL = 'sim-swift'

export function findModel(id: string): ModelSpec | undefined {
  return MODELS.find((m) => m.id === id)
}

/** Rough token estimate (about four characters per token), used for context budgets and usage. */
export function estimateTokens(text: string): number {
  return text.length === 0 ? 0 : Math.ceil(text.length / 4)
}
