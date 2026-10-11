import 'dotenv/config';

const MIB = 1024 * 1024;

function intFromEnv(name: string, fallback: number): number {
  const parsed = parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Application configuration loaded from environment variables with development defaults. */
export const config = {
  port: intFromEnv('PORT', 3001),
  nodeEnv: process.env.NODE_ENV || 'development',
  /** Express `trust proxy` setting; leave false unless a load balancer sets X-Forwarded-For. */
  trustProxy: process.env.TRUST_PROXY === 'true',
  database: {
    url: process.env.DATABASE_URL || 'postgresql://loom:loom123@localhost:5432/loom',
  },
  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },
  minio: {
    endpoint: process.env.MINIO_ENDPOINT || 'localhost',
    port: intFromEnv('MINIO_PORT', 9000),
    useSSL: process.env.MINIO_USE_SSL === 'true',
    accessKey: process.env.MINIO_ACCESS_KEY || 'minioadmin',
    secretKey: process.env.MINIO_SECRET_KEY || 'minioadmin',
    bucket: process.env.MINIO_BUCKET || 'loom-videos',
    // A fixed region makes presigning pure local HMAC work. Without it the client
    // asks the bucket for its location before the first presign.
    region: process.env.MINIO_REGION || 'us-east-1',
  },
  upload: {
    // S3 and MinIO reject multipart parts under 5 MiB, except the last one.
    partSizeBytes: Math.max(5 * MIB, intFromEnv('UPLOAD_PART_SIZE_BYTES', 5 * MIB)),
    maxParts: 10000,
    partUrlTtlSeconds: intFromEnv('UPLOAD_PART_URL_TTL_SECONDS', 900),
    playbackUrlTtlSeconds: 3600,
    // An upload with no part requested for this long is treated as abandoned.
    staleAfterMinutes: intFromEnv('UPLOAD_STALE_MINUTES', 30),
    // How often the API process sweeps abandoned uploads; 0 disables the sweeper.
    sweepIntervalMs: intFromEnv('UPLOAD_SWEEP_INTERVAL_MS', 5 * 60 * 1000),
  },
  worker: {
    pollIntervalMs: intFromEnv('WORKER_POLL_INTERVAL_MS', 2000),
    leaseSeconds: intFromEnv('WORKER_LEASE_SECONDS', 600),
    maxAttempts: intFromEnv('WORKER_MAX_ATTEMPTS', 5),
    ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
    ffprobePath: process.env.FFPROBE_PATH || 'ffprobe',
  },
  session: {
    secret: process.env.SESSION_SECRET || 'loom-dev-secret-change-in-production',
    maxAge: 24 * 60 * 60 * 1000,
  },
  shareGrant: {
    // Signs the cookie that remembers which share links this browser has opened.
    secret:
      process.env.SHARE_GRANT_SECRET ||
      process.env.SESSION_SECRET ||
      'loom-dev-secret-change-in-production',
    ttlMs: 12 * 60 * 60 * 1000,
  },
  cors: {
    origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
    credentials: true,
  },
};
