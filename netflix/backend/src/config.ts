// Database configuration
export const DB_CONFIG = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'netflix',
  user: process.env.DB_USER || 'netflix',
  password: process.env.DB_PASSWORD || 'netflix_secret',
};

// Redis configuration
export const REDIS_CONFIG = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
};

// MinIO/S3 configuration
export const MINIO_CONFIG = {
  endpoint: process.env.MINIO_ENDPOINT || 'http://localhost:9000',
  accessKeyId: process.env.MINIO_ACCESS_KEY || 'minioadmin',
  secretAccessKey: process.env.MINIO_SECRET_KEY || 'minioadmin123',
  region: process.env.MINIO_REGION || 'us-east-1',
  bucket: process.env.MINIO_BUCKET || 'videos',
  thumbnailBucket: process.env.MINIO_THUMBNAIL_BUCKET || 'thumbnails',
};

// Server configuration
export const SERVER_CONFIG = {
  port: parseInt(process.env.PORT || '3001'),
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  sessionSecret: process.env.SESSION_SECRET || 'netflix-session-secret-change-in-prod',
  sessionMaxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
};

// Video streaming configuration
export const STREAMING_CONFIG = {
  segmentDuration: 4, // seconds
  qualities: [
    { name: '240p', width: 426, height: 240, bitrate: 235 },
    { name: '360p', width: 640, height: 360, bitrate: 560 },
    { name: '480p', width: 854, height: 480, bitrate: 1050 },
    { name: '720p', width: 1280, height: 720, bitrate: 2350 },
    { name: '1080p', width: 1920, height: 1080, bitrate: 4300 },
    { name: '4k', width: 3840, height: 2160, bitrate: 15000 },
  ],
};
