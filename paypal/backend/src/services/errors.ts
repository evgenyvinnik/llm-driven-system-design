import type { Response } from 'express';
import { logger } from './logger.js';

/**
 * An expected, client-facing failure (validation, not found, insufficient
 * funds, conflict). Anything else is a bug and is reported as a generic 500 so
 * database error text never reaches the client.
 */
export class PaymentError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PaymentError';
  }
}

/** Sends a PaymentError as its own status, anything else as a logged 500. */
export function sendError(res: Response, err: unknown, logMessage: string): void {
  if (err instanceof PaymentError) {
    res.status(err.status).json({ error: err.message, code: err.code });
    return;
  }
  logger.error({ err }, logMessage);
  res.status(500).json({ error: 'Internal server error' });
}
