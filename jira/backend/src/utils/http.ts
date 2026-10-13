import { Response } from 'express';
import { ZodError } from 'zod';

/**
 * Optimistic-concurrency helpers. An issue's version column is exposed as a strong
 * entity tag ("7"); a client sends it back in If-Match and gets 412 when it is stale.
 */
export function setVersionTag(res: Response, version: number | undefined): void {
  if (typeof version === 'number') res.setHeader('ETag', `"${version}"`);
}

/**
 * Reads If-Match as the version the client last saw.
 * Returns undefined when the header is absent or '*' (no precondition), the version for
 * '"7"' or '7', and null for anything else, including weak tags: If-Match uses strong
 * comparison, so a weak tag can never match.
 */
export function parseIfMatch(header: string | undefined): number | undefined | null {
  const value = header?.trim();
  if (!value || value === '*') return undefined;
  const match = value.match(/^"?(\d{1,9})"?$/);
  return match ? parseInt(match[1], 10) : null;
}

/** 400 response for a request body that failed schema validation. */
export function sendValidationError(res: Response, error: ZodError): void {
  const { formErrors, fieldErrors } = error.flatten();
  res.status(400).json({
    error: formErrors[0] ?? 'Invalid request',
    code: 'invalid_request',
    details: fieldErrors,
  });
}
