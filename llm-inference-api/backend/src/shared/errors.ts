/**
 * Typed HTTP errors in the Messages API error shape:
 * `{ type: 'error', error: { type, message } }`. The `type` values are the
 * contract clients branch on (rate_limit_error vs overloaded_error, ...).
 * @module shared/errors
 */
import type { NextFunction, Request, Response } from 'express'
import { ZodError } from 'zod'
import { logger } from './logger.js'

export type ApiErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'permission_error'
  | 'not_found_error'
  | 'conflict_error'
  | 'rate_limit_error'
  | 'overloaded_error'
  | 'timeout_error'
  | 'api_error'

export class ApiError extends Error {
  constructor(
    public status: number,
    public type: ApiErrorType,
    message: string,
    public headers: Record<string, string> = {},
    public details?: unknown,
  ) {
    super(message)
  }
}

export const notFound = (what: string) => new ApiError(404, 'not_found_error', `${what} not found`)

export function errorBody(type: string, message: string, details?: unknown) {
  return { type: 'error', error: { type, message, ...(details ? { details } : {}) } }
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (res.headersSent) {
    res.end()
    return
  }
  if (err instanceof ApiError) {
    for (const [k, v] of Object.entries(err.headers)) res.setHeader(k, v)
    res.status(err.status).json(errorBody(err.type, err.message, err.details))
    return
  }
  if (err instanceof ZodError) {
    res.status(400).json(
      errorBody(
        'invalid_request_error',
        err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
      ),
    )
    return
  }
  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json(errorBody('invalid_request_error', 'Request body is not valid JSON'))
    return
  }
  logger.error({ err, path: req.path }, 'unhandled error')
  res.status(500).json(errorBody('api_error', 'Internal server error'))
}

/** Wraps an async handler so rejected promises reach the error middleware. */
export function asyncHandler<T extends Request = Request>(
  fn: (req: T, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req as T, res, next).catch(next)
  }
}
