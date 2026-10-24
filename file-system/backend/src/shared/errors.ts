/**
 * HTTP error mapping. Route handlers throw `HttpError` or let an `FsError` from
 * the backend through; the error middleware turns either into
 * `{ error: { code, message, details } }` with the right status.
 * @module shared/errors
 */
import type { NextFunction, Request, Response } from 'express'
import { ZodError } from 'zod'
import { FsError, type FsErrorCode } from '../store/backend.js'
import { logger } from './logger.js'
import { writesRefused } from './metrics.js'

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

/**
 * Namespace and quota refusals are 409: the request is valid but conflicts with
 * the current state of the tree or of the user's usage. Clients must not retry
 * them unchanged, which is why quota isn't a 5xx (507 would invite retries).
 */
const fsStatus: Record<FsErrorCode, number> = {
  PATH_EXISTS: 409,
  PATH_IS_DIRECTORY: 409,
  PARENT_IS_FILE: 409,
  OVER_CAPACITY: 409,
  USER_EXISTS: 409,
  FILE_NOT_FOUND: 404,
  NOT_A_DIRECTORY: 404,
  USER_NOT_FOUND: 404,
  SAME_USER: 422,
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (res.headersSent) {
    res.end()
    return
  }
  if (err instanceof FsError) {
    if (req.method !== 'GET') writesRefused.inc({ code: err.code })
    res.status(fsStatus[err.code]).json({ error: { code: err.code, message: err.message } })
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
        message: err.issues[0]?.message ?? 'Request is invalid',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
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
export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next)
  }
}
