/**
 * Environment configuration. Every value has a local default so `npm run dev`
 * works against the docker-compose stack with no .env file.
 * @module shared/config
 */

function int(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

const port = int('PORT', 3000)

export const config = {
  databaseUrl: process.env.DATABASE_URL || 'postgresql://settings:settings_password@localhost:5432/settings_service',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  /** Every Valkey key and channel this project uses starts with this, so a shared dev Valkey stays tidy. */
  keyPrefix: process.env.KEY_PREFIX || 'ss:',

  port,
  /** Shown in responses (X-Instance-Id) and SSE hello events, so the cross-instance demo is visible. */
  instanceId: process.env.INSTANCE_ID || `api-${port}`,

  sessionCookie: 'settings_session',
  sessionTtlSeconds: int('SESSION_TTL_SECONDS', 7 * 24 * 60 * 60),

  /** How long an instance trusts its in-memory catalog before re-reading it, even without a pub/sub invalidation. */
  catalogTtlMs: int('CATALOG_TTL_MS', 30_000),
  /** Default grace window when a key is deprecated without an explicit one. */
  defaultGraceDays: int('DEFAULT_GRACE_DAYS', 30),
  /** Per-user PATCH budget per minute. Settings change at human speed; a loop that writes faster is a bug. */
  patchesPerMinute: int('PATCHES_PER_MINUTE', 120),
  /** Dev chaos switches (drop the next PATCH response after commit). Off in production unless forced. */
  chaosEnabled: (process.env.CHAOS_ENABLED ?? (process.env.NODE_ENV === 'production' ? 'false' : 'true')) === 'true',
  sseHeartbeatMs: int('SSE_HEARTBEAT_MS', 15_000),
}
