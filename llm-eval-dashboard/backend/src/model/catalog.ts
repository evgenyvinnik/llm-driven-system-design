/**
 * Mock models. Each has a base error rate (how often it slips on an easy
 * case), a context window, and latency characteristics.
 * @module model/catalog
 */

export interface ModelSpec {
  id: string
  label: string
  baseError: number
  contextTokens: number
  ttftMs: number
  tokensPerSecond: number
}

export const MODELS: Record<string, ModelSpec> = {
  'mock-small': { id: 'mock-small', label: 'Mock Small (fast, 1k context)', baseError: 0.08, contextTokens: 1024, ttftMs: 220, tokensPerSecond: 90 },
  'mock-large': { id: 'mock-large', label: 'Mock Large (careful, 8k context)', baseError: 0.03, contextTokens: 8192, ttftMs: 380, tokensPerSecond: 55 },
  /** A model whose window is too small for any real prompt: every call is a permanent error. */
  'mock-tiny': { id: 'mock-tiny', label: 'Mock Tiny (64-token context)', baseError: 0.2, contextTokens: 64, ttftMs: 120, tokensPerSecond: 120 },
}

export const MODEL_IDS = Object.keys(MODELS) as [string, ...string[]]

/** Rough token estimate (≈ 4 characters per token), used for context checks and input usage. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}

/** Splits text into word-sized tokens that keep trailing whitespace, so joining restores the text. */
export function tokenize(text: string): string[] {
  return text.match(/\S+\s*/g) ?? []
}

/**
 * The seed a worker sends for one sample: the config's base seed combined
 * with the sample index, so samples differ from each other but a re-run of
 * the same (config, case, sample) reproduces exactly.
 */
export function sampleSeed(baseSeed: number, sampleIndex: number): number {
  return baseSeed * 1000 + sampleIndex
}
