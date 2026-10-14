import { createHash, randomUUID } from 'node:crypto';
import { redis } from './redis.js';
import { createLogger } from './logger.js';
import { idempotencyCacheHits } from './metrics.js';
import { Logger } from 'pino';

const log: Logger = createLogger('idempotency');

/** How long a completed response is replayed for. */
const COMPLETED_TTL_SECONDS = 86400;
/** How long a claim may stay 'processing' before another request may take over. */
const PROCESSING_TTL_SECONDS = 60;

interface IdempotencyRecord {
  state: 'processing' | 'completed';
  fingerprint: string;
  token: string;
  status?: number;
  body?: unknown;
}

export type IdempotencyBegin =
  | { kind: 'new'; token: string }
  | { kind: 'replay'; status: number; body: unknown }
  | { kind: 'in_progress' }
  | { kind: 'mismatch' }
  | { kind: 'unavailable' };

// Both scripts act only while the stored record still carries our claim token,
// so a request whose claim expired cannot overwrite or delete a newer claim.
const COMPLETE_IF_OWNER = `
local current = redis.call('GET', KEYS[1])
if not current then return 0 end
local ok, record = pcall(cjson.decode, current)
if not ok or record.token ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'EX', tonumber(ARGV[3]))
return 1
`;

const RELEASE_IF_OWNER = `
local current = redis.call('GET', KEYS[1])
if not current then return 0 end
local ok, record = pcall(cjson.decode, current)
if ok and record.token == ARGV[1] then
  redis.call('DEL', KEYS[1])
  return 1
end
return 0
`;

/** JSON with object keys sorted, so equal payloads always hash the same. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * HTTP idempotency for POST /notifications (Idempotency-Key header).
 *
 * Keys are scoped by the caller, so one user's key can never return another
 * user's response, and they are bound to a fingerprint of the request body:
 * the same key with a different body is a client bug and gets 422 instead of
 * someone else's cached result. Only successful (2xx) responses are stored;
 * anything else releases the claim so the client can retry with the same key.
 */
export class IdempotencyService {
  buildKey(scope: string, key: string): string {
    return `idempotency:${scope}:${key}`;
  }

  fingerprint(payload: unknown): string {
    return createHash('sha256').update(stableStringify(payload)).digest('hex');
  }

  /** Claims the key with SET NX, or explains why this request must not run. */
  async begin(scope: string, key: string, fingerprint: string): Promise<IdempotencyBegin> {
    const redisKey = this.buildKey(scope, key);
    const token = randomUUID();
    const claim: IdempotencyRecord = { state: 'processing', fingerprint, token };

    try {
      const claimed = await redis.set(redisKey, JSON.stringify(claim), 'EX', PROCESSING_TTL_SECONDS, 'NX');
      if (claimed === 'OK') {
        return { kind: 'new', token };
      }

      const existing = await redis.get(redisKey);
      if (!existing) {
        // The other claim expired between our SET and GET; let the client retry.
        return { kind: 'in_progress' };
      }
      const record = JSON.parse(existing) as IdempotencyRecord;
      if (record.fingerprint !== fingerprint) {
        return { kind: 'mismatch' };
      }
      if (record.state === 'processing') {
        return { kind: 'in_progress' };
      }
      idempotencyCacheHits.inc();
      return { kind: 'replay', status: record.status ?? 200, body: record.body };
    } catch (error) {
      // Fail open: a Redis outage should not stop notifications being accepted.
      log.error({ err: error, key: redisKey }, 'Idempotency store unavailable; proceeding without it');
      return { kind: 'unavailable' };
    }
  }

  /** Stores the response for replay, if this request still owns the claim. */
  async complete(scope: string, key: string, token: string, fingerprint: string, status: number, body: unknown): Promise<void> {
    const record: IdempotencyRecord = { state: 'completed', fingerprint, token, status, body };
    try {
      await redis.eval(COMPLETE_IF_OWNER, 1, this.buildKey(scope, key), token, JSON.stringify(record), String(COMPLETED_TTL_SECONDS));
    } catch (error) {
      log.error({ err: error, scope, key }, 'Could not store idempotent response');
    }
  }

  /** Gives the key back so the client can retry (non-2xx outcomes). */
  async release(scope: string, key: string, token: string): Promise<void> {
    try {
      await redis.eval(RELEASE_IF_OWNER, 1, this.buildKey(scope, key), token);
    } catch (error) {
      log.error({ err: error, scope, key }, 'Could not release idempotency claim');
    }
  }
}

export const idempotencyService = new IdempotencyService();

export default idempotencyService;
