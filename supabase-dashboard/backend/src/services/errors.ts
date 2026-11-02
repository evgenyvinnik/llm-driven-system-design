import type { Response } from 'express';
import { logger } from './logger.js';

/**
 * An error whose message is safe to show the client, with the HTTP status it
 * maps to. Anything else that reaches a route's catch block is logged and
 * answered with a generic 500, so metadata-database internals never leak.
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Sends an ApiError as its own status; logs anything else and sends a generic 500. */
export function respondError(res: Response, err: unknown, fallback: string): void {
  if (err instanceof ApiError) {
    if (err.status >= 500) logger.error({ err }, fallback);
    res.status(err.status).json({ error: err.message, ...err.details });
    return;
  }
  logger.error({ err }, fallback);
  res.status(500).json({ error: fallback });
}
