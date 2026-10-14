/**
 * @fileoverview Error type that carries an HTTP status, thrown by services and
 * turned into a JSON response by the route handlers.
 */

import type { Response } from 'express';

/**
 * An expected failure with a status code and optional extra response fields
 * (for example the current block on a 409 version conflict).
 */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/**
 * Sends an HttpError as `{ error, ...body }`; anything else is logged and
 * answered with a generic 500.
 *
 * @param res - Express response
 * @param error - The caught error
 * @param fallbackMessage - Message used for unexpected errors
 */
export function sendError(res: Response, error: unknown, fallbackMessage: string): void {
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message, ...error.body });
    return;
  }
  console.error(`${fallbackMessage}:`, error);
  res.status(500).json({ error: fallbackMessage });
}
