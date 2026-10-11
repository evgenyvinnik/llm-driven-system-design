/**
 * Error carrying an HTTP status, thrown by services for client-caused failures
 * (validation, conflicts). Anything else is treated as a 500 by the error handler.
 */
export class HttpError extends Error {
  readonly status: number;

  /**
   * @param status - HTTP status code to respond with
   * @param message - Client-safe error message
   */
  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

/**
 * PostgreSQL SQLSTATE for unique_violation.
 */
export const PG_UNIQUE_VIOLATION = '23505';

/**
 * Reads the SQLSTATE code from a node-postgres error, if present.
 * @param error - Any thrown value
 * @returns The five-character SQLSTATE, or undefined
 */
export function pgErrorCode(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}
