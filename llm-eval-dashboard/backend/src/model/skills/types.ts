import type { ModelSpec } from '../catalog.js'

export interface SkillContext {
  /** The rendered user prompt (variables substituted). */
  prompt: string
  system: string
  /** system + prompt, lowercased, for instruction detection. */
  text: string
  spec: ModelSpec
  /**
   * A number in [0, 1) for one decision point (`label`). Deterministic for the
   * same (model, prompt); mixes in per-sample randomness in proportion to the
   * temperature, so temperature 0 gives identical samples.
   */
  draw: (label: string) => number
}

export interface SkillOutput {
  text: string
  /** Debug info for tests (never sent to clients). */
  detail: Record<string, unknown>
}
