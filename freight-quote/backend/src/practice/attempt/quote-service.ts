/**
 * Practice attempt: the quote service layer. Read ../../../../coding-exercise.md first.
 *
 *   npm run practice          run the suite against this file
 *   npm run practice:watch    rerun on save
 *   npm run practice:reset    restore this stub (your attempt is overwritten)
 *
 * Keep the exports and their signatures. Everything else is yours.
 */
import type { DependencyName, Quote, QuoteRequest, QuoteServiceApi, QuoteServiceDeps, QuoteServiceOptions } from '../types.js'

/**
 * The cache key for one dependency's component. Decide what must be in it,
 * and what must not, so that a cached price is only ever served to a
 * customer who would be charged that same price.
 */
export function componentCacheKey(_dependency: DependencyName, _request: QuoteRequest): string {
  throw new Error('Not implemented: componentCacheKey')
}

export class QuoteService implements QuoteServiceApi {
  constructor(
    readonly deps: QuoteServiceDeps,
    readonly options: QuoteServiceOptions,
  ) {}

  async submitQuote(_request: QuoteRequest): Promise<Quote> {
    throw new Error('Not implemented: submitQuote')
  }
}
