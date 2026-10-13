import dotenv from 'dotenv';
dotenv.config();

export interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  connectionString: string | undefined;
}

export interface RedisConfig {
  url: string;
  host: string;
  port: number;
}

export interface MinioConfig {
  endPoint: string;
  port: number;
  accessKey: string;
  secretKey: string;
  bucket: string;
  useSSL: boolean;
}

export interface SessionConfig {
  secret: string;
  maxAge: number;
}

export interface FeedConfig {
  /** Authors with at least this many followers are not fanned out; their posts are merged at read time. */
  celebrityFollowerThreshold: number;
  /** Maximum post IDs kept per precomputed timeline. */
  timelineMaxEntries: number;
  /** Idle timelines expire so memory follows active users; a read rebuilds them from PostgreSQL. */
  timelineTtlSeconds: number;
  /** Followers written per Redis pipeline during fan-out. */
  fanoutBatchSize: number;
  /** Recent posts copied into a timeline when the viewer follows a new (non-celebrity) account. */
  followBackfillCount: number;
}

export interface MediaPipelineConfig {
  /** Delivery attempts (first try + retries) before a job is dead-lettered and the post marked failed. */
  maxAttempts: number;
  /** How often the outbox relay polls for unpublished events. */
  relayIntervalMs: number;
  /** Events claimed per relay pass. */
  relayBatchSize: number;
}

export interface Config {
  port: number;
  nodeEnv: string;
  database: DatabaseConfig;
  redis: RedisConfig;
  minio: MinioConfig;
  session: SessionConfig;
  feed: FeedConfig;
  mediaPipeline: MediaPipelineConfig;
}

const intFromEnv = (name: string, fallback: number): number => {
  const parsed = parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const config: Config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',

  database: {
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    database: process.env.POSTGRES_DB || 'instagram',
    user: process.env.POSTGRES_USER || 'instagram',
    password: process.env.POSTGRES_PASSWORD || 'instagram123',
    connectionString: process.env.DATABASE_URL,
  },

  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
  },

  minio: {
    endPoint: process.env.MINIO_ENDPOINT || 'localhost',
    port: parseInt(process.env.MINIO_PORT || '9000', 10),
    accessKey: process.env.MINIO_ACCESS_KEY || 'minioadmin',
    secretKey: process.env.MINIO_SECRET_KEY || 'minioadmin123',
    bucket: process.env.MINIO_BUCKET || 'instagram-media',
    useSSL: process.env.MINIO_USE_SSL === 'true',
  },

  session: {
    secret: process.env.SESSION_SECRET || 'dev-session-secret',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  },

  feed: {
    celebrityFollowerThreshold: intFromEnv('FEED_CELEBRITY_THRESHOLD', 10000),
    timelineMaxEntries: intFromEnv('FEED_TIMELINE_MAX_ENTRIES', 500),
    timelineTtlSeconds: intFromEnv('FEED_TIMELINE_TTL_SECONDS', 7 * 24 * 60 * 60),
    fanoutBatchSize: intFromEnv('FEED_FANOUT_BATCH_SIZE', 1000),
    followBackfillCount: intFromEnv('FEED_FOLLOW_BACKFILL', 50),
  },

  mediaPipeline: {
    maxAttempts: intFromEnv('MEDIA_JOB_MAX_ATTEMPTS', 3),
    relayIntervalMs: intFromEnv('OUTBOX_RELAY_INTERVAL_MS', 2000),
    relayBatchSize: intFromEnv('OUTBOX_RELAY_BATCH_SIZE', 50),
  },
};

export default config;
