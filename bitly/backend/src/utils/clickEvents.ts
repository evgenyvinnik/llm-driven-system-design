/**
 * Click event message policy: parsing, validation, and the retry/dead-letter decision.
 * Pure functions only (no broker or database access) so the consumer's behavior can be
 * unit tested without RabbitMQ.
 */
import crypto from 'crypto';
import type { ClickEventMessage } from '../models/types.js';
import { pgErrorCode } from './errors.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHORT_CODE_PATTERN = /^[A-Za-z0-9_-]{1,10}$/;

/** Header carrying how many delayed retries a message has already had. */
export const RETRY_COUNT_HEADER = 'x-retry-count';

/**
 * Result of parsing a raw queue message.
 * legacyId is true when the message predates event_id and the id was derived.
 */
export type ParsedClickEvent =
  | { ok: true; event: ClickEventMessage; legacyId: boolean }
  | { ok: false; error: string };

/**
 * Derives a stable UUID for a message published before event_id existed.
 * A redelivery carries identical bytes, so it maps to the same id and is deduplicated;
 * two genuinely distinct legacy clicks with byte-identical payloads would merge, which
 * is acceptable for the short drain window after a deploy.
 * @param content - Raw message body
 * @returns UUID-formatted string (version 8, RFC 9562 "custom")
 */
export function deriveLegacyEventId(content: Buffer | string): string {
  const hex = crypto.createHash('sha256').update(content).digest('hex');
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `8${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

/**
 * Parses and validates a raw click event. Anything that fails here can never succeed on
 * a retry, so the consumer sends it straight to the dead-letter queue.
 * @param content - Raw message body
 * @returns The validated event or a reason it is malformed
 */
export function parseClickEventMessage(content: Buffer | string): ParsedClickEvent {
  let raw: unknown;
  try {
    raw = JSON.parse(content.toString());
  } catch {
    return { ok: false, error: 'payload is not valid JSON' };
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'payload is not a JSON object' };
  }
  const body = raw as Record<string, unknown>;

  if (typeof body.short_code !== 'string' || !SHORT_CODE_PATTERN.test(body.short_code)) {
    return { ok: false, error: 'short_code is missing or invalid' };
  }
  if (typeof body.timestamp !== 'string' || Number.isNaN(Date.parse(body.timestamp))) {
    return { ok: false, error: 'timestamp is missing or invalid' };
  }
  for (const field of ['referrer', 'user_agent', 'ip_address', 'device_type'] as const) {
    const value = body[field];
    if (value !== undefined && value !== null && typeof value !== 'string') {
      return { ok: false, error: `${field} must be a string` };
    }
  }

  let eventId: string;
  let legacyId = false;
  if (body.event_id === undefined || body.event_id === null) {
    eventId = deriveLegacyEventId(content);
    legacyId = true;
  } else if (typeof body.event_id === 'string' && UUID_PATTERN.test(body.event_id)) {
    eventId = body.event_id.toLowerCase();
  } else {
    return { ok: false, error: 'event_id is not a UUID' };
  }

  const optional = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

  return {
    ok: true,
    legacyId,
    event: {
      event_id: eventId,
      short_code: body.short_code,
      timestamp: body.timestamp,
      referrer: optional(body.referrer),
      user_agent: optional(body.user_agent),
      ip_address: optional(body.ip_address),
      device_type: optional(body.device_type) || 'unknown',
    },
  };
}

/**
 * permanent: the same message will fail the same way every time.
 * transient: worth retrying (database down, timeouts, deadlocks).
 */
export type ErrorKind = 'permanent' | 'transient';

/**
 * Classifies a processing error. SQLSTATE class 22 (data exception, e.g. an invalid
 * inet value) and class 23 (integrity violation, e.g. a foreign key to a code that does
 * not exist) are deterministic; everything else is assumed transient.
 * @param error - Error thrown by the handler
 */
export function classifyProcessingError(error: unknown): ErrorKind {
  const code = pgErrorCode(error);
  if (code && /^(22|23)[0-9A-Z]{3}$/.test(code)) {
    return 'permanent';
  }
  return 'transient';
}

/**
 * What to do with a message whose processing failed.
 */
export type FailureDecision =
  | { action: 'retry'; retryCount: number }
  | { action: 'dead-letter'; reason: 'permanent_error' | 'max_attempts' };

/**
 * Decides between a delayed retry and the dead-letter queue.
 * @param retryCount - Retries already performed (0 on the first delivery)
 * @param maxAttempts - Total processing attempts allowed, first delivery included
 * @param kind - Classification of the failure
 */
export function decideFailureAction(retryCount: number, maxAttempts: number, kind: ErrorKind): FailureDecision {
  if (kind === 'permanent') {
    return { action: 'dead-letter', reason: 'permanent_error' };
  }
  if (retryCount + 1 >= maxAttempts) {
    return { action: 'dead-letter', reason: 'max_attempts' };
  }
  return { action: 'retry', retryCount: retryCount + 1 };
}

/**
 * Reads the retry counter from AMQP headers (numbers may arrive as strings).
 * @param headers - Message headers
 * @returns Non-negative integer, 0 when absent or invalid
 */
export function readRetryCount(headers: Record<string, unknown> | undefined): number {
  const raw = headers?.[RETRY_COUNT_HEADER];
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? parseInt(raw, 10) : NaN;
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

/**
 * Copies headers for a republished message, dropping the broker's dead-lettering
 * bookkeeping (x-death and friends) that the retry round trip adds; x-retry-count is the
 * counter we rely on.
 * @param headers - Original message headers
 */
export function stripBrokerHeaders(headers: Record<string, unknown> | undefined): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key === 'x-death' || key.startsWith('x-first-death') || key.startsWith('x-last-death')) {
      continue;
    }
    copy[key] = value;
  }
  return copy;
}
