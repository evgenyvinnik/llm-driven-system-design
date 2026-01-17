module.exports = {
  port: process.env.PORT || 3001,
  database: {
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    user: process.env.DB_USER || 'appletv',
    password: process.env.DB_PASSWORD || 'appletv_secret',
    database: process.env.DB_NAME || 'appletv'
  },
  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379'
  },
  minio: {
    endPoint: process.env.MINIO_ENDPOINT || 'localhost',
    port: parseInt(process.env.MINIO_PORT || '9000'),
    useSSL: process.env.MINIO_USE_SSL === 'true',
    accessKey: process.env.MINIO_ACCESS_KEY || 'minioadmin',
    secretKey: process.env.MINIO_SECRET_KEY || 'minioadmin'
  },
  session: {
    secret: process.env.SESSION_SECRET || 'appletv-session-secret-change-in-production',
    name: 'appletv.sid',
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  },
  buckets: {
    videos: 'videos',
    thumbnails: 'thumbnails'
  }
};
