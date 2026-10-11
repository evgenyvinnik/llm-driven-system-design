/**
 * Domain errors that carry an HTTP status and a stable machine-readable code.
 * Services throw these for expected outcomes (not found, conflict, bad input);
 * routes translate them into responses. Anything else is an unexpected failure
 * and becomes a generic 500 so database messages never reach the client.
 *
 * @module utils/errors
 */
import type { Response } from 'express';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Writes an ApiError as `{ error, code }` with its status.
 *
 * @param res - Express response
 * @param error - Any thrown value
 * @returns True if the error was an ApiError and a response was sent
 */
export function sendApiError(res: Response, error: unknown): boolean {
  if (error instanceof ApiError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return true;
  }
  return false;
}

/**
 * Parses a positive integer id from a route param or body field.
 *
 * @param value - Raw value (string from params, number from JSON)
 * @param field - Field name for the error message
 * @returns The id
 * @throws ApiError 400 when the value is not a positive integer
 */
export function parseId(value: unknown, field = 'id'): number {
  const id = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(id) || id <= 0 || String(id) !== String(value).trim()) {
    throw new ApiError(400, 'invalid_id', `${field} must be a positive integer`);
  }
  return id;
}
