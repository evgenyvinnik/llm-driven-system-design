/**
 * Runtime knobs of the mock model service, adjustable from the admin page so
 * slow, failing and disconnecting generations can be produced on demand.
 * @module shared/model-settings
 */
import { z } from 'zod'

export interface ModelSettings {
  /** Overrides every model's time to first token when set. */
  ttftMsOverride: number | null
  /** Overrides every model's streaming speed when set. */
  tokensPerSecondOverride: number | null
  /** Overrides every model's failure rate (an explicit error event mid-stream) when set. */
  failureRateOverride: number | null
  /** Probability that the model drops the connection mid-stream with no error and no end. */
  disconnectRate: number
  /** Generations allowed at once before the model returns 429. */
  maxConcurrent: number
}

export const DEFAULT_MODEL_SETTINGS: ModelSettings = {
  ttftMsOverride: null,
  tokensPerSecondOverride: null,
  failureRateOverride: null,
  disconnectRate: 0,
  maxConcurrent: 16,
}

export const modelSettingsPatchSchema = z
  .object({
    ttftMsOverride: z.number().int().min(0).max(30_000).nullable(),
    tokensPerSecondOverride: z.number().min(1).max(500).nullable(),
    failureRateOverride: z.number().min(0).max(1).nullable(),
    disconnectRate: z.number().min(0).max(1),
    maxConcurrent: z.number().int().min(1).max(100),
  })
  .partial()
  .strict()
