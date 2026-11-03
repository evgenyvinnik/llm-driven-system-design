/**
 * Environment configuration shared by the API, ingest, exporter and generator.
 * Every value has a local-development default so `npm run dev` works with the
 * docker-compose stack and no .env file.
 * @module shared/config
 */

function int(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

export const config = {
  databaseUrl:
    process.env.DATABASE_URL || 'postgresql://analytics:analytics_password@localhost:5432/chat_analytics',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  clickhouse: {
    url: process.env.CLICKHOUSE_URL || 'http://localhost:8123',
    username: process.env.CLICKHOUSE_USER || 'analytics',
    password: process.env.CLICKHOUSE_PASSWORD || 'analytics_password',
    database: process.env.CLICKHOUSE_DATABASE || 'chat_analytics',
  },
  kafka: {
    brokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(','),
    topic: process.env.KAFKA_TOPIC || 'chat-events',
    partitions: int('KAFKA_PARTITIONS', 3),
    groupId: process.env.KAFKA_GROUP_ID || 'ingest',
  },

  apiPort: int('PORT', 3000),
  ingestPort: int('INGEST_PORT', 3101),
  exporterPort: int('EXPORTER_PORT', 3102),

  sessionCookie: 'lca_session',
  sessionTtlSeconds: int('SESSION_TTL_SECONDS', 7 * 24 * 60 * 60),

  /**
   * How long after an event happened it may still arrive and count as on time,
   * per stream. Server events come from our own services; client events come
   * from phones and laptops that go offline, so they get a longer allowance.
   */
  latenessAllowanceMs: {
    server: int('SERVER_LATENESS_MS', 60_000),
    client: int('CLIENT_LATENESS_MS', 10 * 60_000),
  },
  /** Events older than this when received are rejected: those buckets are sealed. */
  maxLatenessMs: int('MAX_LATENESS_HOURS', 72) * 3_600_000,
  /** Dedup claims outlive the maximum lateness, so a duplicate can never land after its claim expired. */
  dedupTtlSeconds: int('DEDUP_TTL_HOURS', 96) * 3600,
  /** A client event more than this far in the future is treated as clock skew and re-stamped. */
  maxClockSkewMs: int('MAX_CLOCK_SKEW_MS', 60_000),
  /** A partition whose position has not moved for this long holds the watermark back (its owner may be dead). */
  partitionStaleMs: int('PARTITION_STALE_MS', 30_000),

  /** Breakdown rows and drill-downs covering fewer distinct users than this are suppressed. */
  minCohortUsers: int('MIN_COHORT_USERS', 5),
  /** Query cache TTLs: open windows change every few seconds, sealed ones only on late data. */
  openWindowCacheSeconds: int('OPEN_WINDOW_CACHE_SECONDS', 10),
  sealedWindowCacheSeconds: int('SEALED_WINDOW_CACHE_SECONDS', 600),
  queryTimeoutMs: int('QUERY_TIMEOUT_MS', 8000),
  /** Demo knob: delay each widget query by a random 0..N ms, so responses come back out of order. */
  queryDelayMs: int('QUERY_DELAY_MS', 0),

  exportDir: process.env.EXPORT_DIR || new URL('../../exports/', import.meta.url).pathname,
  exportPageDelayMs: int('EXPORT_PAGE_DELAY_MS', 250),
  exportLeaseSeconds: int('EXPORT_LEASE_SECONDS', 30),
  exportTtlHours: int('EXPORT_TTL_HOURS', 24),

  /** Live generator pace: simulated events per real second are scaled by this. */
  liveMultiplier: Number(process.env.LIVE_MULTIPLIER || '1'),
  duplicateRate: Number(process.env.DUPLICATE_RATE || '0.02'),
  lateRate: Number(process.env.LATE_RATE || '0.03'),
}
