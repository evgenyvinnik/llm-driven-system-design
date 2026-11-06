/**
 * What the practice suite runs against: the reference solution by default
 * (so `npm test` stays green), or your attempt with PRACTICE_TARGET=attempt
 * (`npm run practice`).
 * @module practice/subject
 */
import type { PracticeModule } from './types.js'

export const PRACTICE_TARGET = process.env.PRACTICE_TARGET === 'attempt' ? 'attempt' : 'reference'

const mod = (PRACTICE_TARGET === 'attempt' ? await import('./attempt/quote-service.js') : await import('./reference/quote-service.js')) as PracticeModule

export const QuoteService = mod.QuoteService
export const componentCacheKey = mod.componentCacheKey
