/**
 * Environment configuration shared by the API and the export worker. Every
 * value has a local-development default so `npm run dev` works with the
 * docker-compose stack and no .env file.
 * @module shared/config
 */
import { fileURLToPath } from 'node:url'

function int(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

export const config = {
  databaseUrl:
    process.env.DATABASE_URL || 'postgresql://console:console_password@localhost:5432/multi_org_dashboard',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',

  apiPort: int('PORT', 3000),

  sessionCookie: 'mod_session',
  sessionTtlSeconds: int('SESSION_TTL_SECONDS', 7 * 24 * 60 * 60),

  /**
   * Cached effective-permission sets live this long. The cache key also carries
   * the org's authz version, so a membership change makes old entries
   * unreachable at once; the TTL only bounds staleness if that bump is lost.
   */
  permissionCacheTtlSeconds: int('PERMISSION_CACHE_TTL_SECONDS', 60),

  /** Heartbeat on the event stream; also the interval at which a stream re-checks membership. */
  sseHeartbeatMs: int('SSE_HEARTBEAT_MS', 20_000),

  workerId: process.env.WORKER_ID || `worker-${process.pid}`,
  workerPollMs: int('WORKER_POLL_MS', 1000),
  /** A running export whose worker stops renewing its lease is picked up again after this. */
  exportLeaseSeconds: int('EXPORT_LEASE_SECONDS', 30),
  exportBatchSize: int('EXPORT_BATCH_SIZE', 250),
  /** Artificial pause between batches so progress is visible with seed-sized data. */
  exportBatchDelayMs: int('EXPORT_BATCH_DELAY_MS', 120),
  exportMaxAttempts: int('EXPORT_MAX_ATTEMPTS', 3),
  exportDir: process.env.EXPORT_DIR || fileURLToPath(new URL('../../exports', import.meta.url)),

  invitationTtlDays: int('INVITATION_TTL_DAYS', 7),
}
