/**
 * Runtime knobs of the mock model service, adjustable from the admin page so
 * failure and overload paths can be exercised on demand.
 * @module shared/model-settings
 */
import { z } from 'zod'

export interface ModelSettings {
  /** Overrides every model's failure rate when set. */
  failureRateOverride: number | null
  /** Scales time to first token and per-token delay. */
  latencyMultiplier: number
  /** Generations allowed at once before the model returns 429. */
  maxConcurrent: number
}

export const modelSettingsPatchSchema = z
  .object({
    failureRateOverride: z.number().min(0).max(1).nullable(),
    latencyMultiplier: z.number().min(0.1).max(10),
    maxConcurrent: z.number().int().min(1).max(100),
  })
  .partial()
  .strict()
