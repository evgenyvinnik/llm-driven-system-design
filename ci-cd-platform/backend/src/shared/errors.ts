/**
 * Typed HTTP errors. Route handlers throw `HttpError`; the error middleware turns
 * it into `{ error: { code, message, details } }` with the given status.
 * @module shared/errors
 */
import type { NextFunction, Request, Response } from 'express'
import { ZodError } from 'zod'
import { logger } from './logger.js'

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message)
  }
}

export const notFound = (what: string) => new HttpError(404, 'NOT_FOUND', `${what} not found`)

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (res.headersSent) {
    res.end()
    return
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } })
    return
  }
  if (err instanceof ZodError) {
    res.status(422).json({
      error: {
        code: 'VALIDATION_FAILED',
        message: 'Request body is invalid',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    })
    return
  }
  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON' } })
    return
  }
  if (typeof err === 'object' && err !== null && (err as { type?: string }).type === 'entity.too.large') {
    res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large' } })
    return
  }
  // The pool is saturated (a burst). Honest and retryable: a Git host redelivers, and the delivery id dedupes.
  if (err instanceof Error && err.message === 'timeout exceeded when trying to connect') {
    logger.warn({ path: req.path }, 'database pool saturated')
    res.setHeader('Retry-After', '1')
    res.status(503).json({ error: { code: 'OVERLOADED', message: 'The service is overloaded; retry shortly' } })
    return
  }
  // Node's AggregateError for ECONNREFUSED has an empty message; log the code too.
  logger.error({ err, code: (err as { code?: string }).code, path: req.path }, 'unhandled error')
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } })
}

/** Wraps an async handler so rejected promises reach the error middleware. */
export function asyncHandler<T extends Request = Request>(fn: (req: T, res: Response, next: NextFunction) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req as T, res, next).catch(next)
  }
}
