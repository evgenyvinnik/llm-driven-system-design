/**
 * HTTP-aware error base class and a single place that turns errors into responses.
 *
 * Domain modules throw subclasses of HttpError (invalid transition -> 409,
 * invalid order -> 422, reused idempotency key -> 422, ...). Routes call
 * sendError() so every endpoint maps the same failure to the same status code,
 * and anything unexpected becomes a logged 500 without leaking internals.
 *
 * @module shared/errors
 */
import type { Response } from 'express';
import { logger } from './logger.js';

/**
 * An error that already knows its HTTP status and a stable machine-readable code.
 */
export class HttpError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string,
    public readonly details?: string[]
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * Sends the JSON error envelope used across the API: `{ success: false, error, code? }`.
 *
 * @param res - Express response
 * @param error - Whatever was thrown
 * @param fallbackMessage - Message for unexpected errors (also used as the log message)
 */
export function sendError(res: Response, error: unknown, fallbackMessage: string): void {
  if (error instanceof HttpError) {
    res.status(error.statusCode).json({
      success: false,
      error: error.message,
      code: error.code,
      ...(error.details ? { details: error.details } : {}),
    });
    return;
  }

  logger.error({ error: (error as Error)?.message, stack: (error as Error)?.stack }, fallbackMessage);
  res.status(500).json({ success: false, error: fallbackMessage });
}
