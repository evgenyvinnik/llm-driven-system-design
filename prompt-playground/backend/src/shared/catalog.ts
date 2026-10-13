/**
 * Model catalog shared by the API (validation, /models), the executor, and the
 * mock model service (latency and failure behavior). The ids are simulated
 * models; no real provider is called.
 * @module shared/catalog
 */
import { z } from 'zod'

export interface ModelSpec {
  id: string
  label: string
  description: string
  maxOutputTokens: number
  /** Simulated time to first token. */
  ttftMs: number
  tokensPerSecond: number
  /** Probability that a generation fails partway through. */
  failureRate: number
  style: 'concise' | 'structured'
}

export const MODELS: readonly ModelSpec[] = [
  {
    id: 'sim-fast',
    label: 'Sim Fast',
    description: 'Short, direct answers at about 80 tokens/s',
    maxOutputTokens: 1024,
    ttftMs: 150,
    tokensPerSecond: 80,
    failureRate: 0,
    style: 'concise',
  },
  {
    id: 'sim-quality',
    label: 'Sim Quality',
    description: 'Longer structured answers at about 30 tokens/s',
    maxOutputTokens: 2048,
    ttftMs: 700,
    tokensPerSecond: 30,
    failureRate: 0,
    style: 'structured',
  },
  {
    id: 'sim-flaky',
    label: 'Sim Flaky',
    description: 'Fails partway through about one run in three, for testing error paths',
    maxOutputTokens: 1024,
    ttftMs: 250,
    tokensPerSecond: 50,
    failureRate: 0.35,
    style: 'concise',
  },
]

export const MODEL_IDS = MODELS.map((m) => m.id) as [string, ...string[]]

export function findModel(id: string): ModelSpec | undefined {
  return MODELS.find((m) => m.id === id)
}

/** The parameters a run is executed with. Stored as a snapshot on every run. */
export const modelConfigSchema = z
  .object({
    model: z.enum(MODEL_IDS),
    temperature: z.number().min(0).max(2).default(0.7),
    maxTokens: z.number().int().min(1).max(4096).default(512),
    topP: z.number().min(0).max(1).default(1),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    const spec = findModel(cfg.model)
    if (spec && cfg.maxTokens > spec.maxOutputTokens) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['maxTokens'],
        message: `${spec.id} allows at most ${spec.maxOutputTokens} output tokens`,
      })
    }
  })

export type ModelConfig = z.infer<typeof modelConfigSchema>

/** Rough token estimate (about four characters per token), used by the mock model and limits. */
export function estimateTokens(text: string): number {
  return text.length === 0 ? 0 : Math.ceil(text.length / 4)
}
