/**
 * Typed HTTP errors and the one error envelope every endpoint uses:
 *
 *   { "error": { "code", "message", ...extra } }
 *
 * `extra` carries `fields` (per-field errors on 422), `conflicts` and `current`
 * (on 409/412), or `warnings`. A client can always tell "the server said no"
 * (an envelope) from "I don't know what happened" (no envelope).
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
    public extra: Record<string, unknown> = {},
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
    res.status(err.status).json({ error: { code: err.code, message: err.message, ...err.extra } })
    return
  }
  if (err instanceof ZodError) {
    res.status(422).json({
      error: {
        code: 'VALIDATION_FAILED',
        message: 'Request body is invalid',
        fields: err.issues.map((i) => ({ key: i.path.join('.') || '(body)', code: 'INVALID_FORMAT', message: i.message })),
      },
    })
    return
  }
  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON' } })
    return
  }
  logger.error({ err, path: req.path }, 'unhandled error')
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } })
}

/** Wraps an async handler so rejected promises reach the error middleware. */
export function asyncHandler<T extends Request = Request>(
  fn: (req: T, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req as T, res, next).catch(next)
  }
}
