/**
 * Typed errors for the payment lifecycle, mapped to HTTP status codes by the
 * routes. Business rule violations used to surface as 400 or 500 with a
 * generic message; clients need to tell "not found" from "wrong state" from
 * "retry later".
 */

import type { Response } from 'express';
import { logger } from '../../shared/index.js';

export class PaymentError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'PaymentError';
  }
}

export function notFound(entity: string): PaymentError {
  return new PaymentError(404, 'not_found', `${entity} not found`);
}

/** The payment exists but its state does not allow the requested action. */
export function invalidState(status: string, action: string): PaymentError {
  return new PaymentError(409, 'invalid_state', `Cannot ${action} a payment in status: ${status}`, { status });
}

/** Same Idempotency-Key, different request: never replay someone else's result. */
export function idempotencyKeyReused(): PaymentError {
  return new PaymentError(
    422,
    'idempotency_key_reused',
    'This Idempotency-Key was already used with a different request'
  );
}

/** Another request with the same key is still being processed. */
export function requestInProgress(paymentId: string): PaymentError {
  return new PaymentError(
    409,
    'request_in_progress',
    'A request with this Idempotency-Key is still being processed; retry later',
    { payment_id: paymentId, status: 'pending' }
  );
}

/**
 * Sends a PaymentError as JSON ({ error, code, ...details }); anything else is
 * logged and reported as a 500 without leaking internals.
 */
export function sendError(res: Response, error: unknown, fallbackMessage: string): void {
  if (error instanceof PaymentError) {
    if (error.code === 'request_in_progress') {
      res.setHeader('Retry-After', '2');
    }
    res.status(error.status).json({ error: error.message, code: error.code, ...error.details });
    return;
  }
  logger.error({ error }, fallbackMessage);
  res.status(500).json({ error: fallbackMessage });
}
