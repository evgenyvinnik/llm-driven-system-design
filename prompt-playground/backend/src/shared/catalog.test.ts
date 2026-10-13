import { describe, expect, it } from 'vitest'
import { modelConfigSchema } from './catalog.js'

describe('modelConfigSchema', () => {
  it('fills defaults', () => {
    expect(modelConfigSchema.parse({ model: 'sim-fast' })).toEqual({
      model: 'sim-fast',
      temperature: 0.7,
      maxTokens: 512,
      topP: 1,
    })
  })

  it('rejects unknown models, unknown fields, and over-limit output', () => {
    expect(modelConfigSchema.safeParse({ model: 'gpt-x' }).success).toBe(false)
    expect(modelConfigSchema.safeParse({ model: 'sim-fast', seed: 1 }).success).toBe(false)
    expect(modelConfigSchema.safeParse({ model: 'sim-fast', maxTokens: 2048 }).success).toBe(false)
    expect(modelConfigSchema.safeParse({ model: 'sim-quality', maxTokens: 2048 }).success).toBe(true)
  })
})
