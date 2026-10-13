/**
 * HTTP error type and the shared error-handling middleware
 * @module shared/errors
 */
import type { Request, Response, NextFunction } from 'express'
import type { Logger } from 'pino'

/** An error that maps directly onto an HTTP status code. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

/** PostgreSQL error codes that are the caller's fault rather than the server's. */
const PG_CLIENT_ERRORS: Record<string, { status: number; message: string }> = {
  '22P02': { status: 400, message: 'Malformed identifier' },
  '23503': { status: 422, message: 'Referenced book or user does not exist' },
}

/** Builds the terminal error middleware: HttpError → its status, everything else → 500. */
export function errorHandler(logger: Logger) {
  return (err: Error & { code?: string; status?: number; type?: string }, _req: Request, res: Response, _next: NextFunction): void => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message })
      return
    }
    // express.json() rejects unparseable bodies with a 400 'entity.parse.failed' error
    if (err.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'Request body is not valid JSON' })
      return
    }
    const pgError = err.code ? PG_CLIENT_ERRORS[err.code] : undefined
    if (pgError) {
      res.status(pgError.status).json({ error: pgError.message })
      return
    }
    logger.error({ error: err.message, stack: err.stack })
    res.status(500).json({ error: 'Internal server error' })
  }
}
