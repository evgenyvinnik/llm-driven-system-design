import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',

  database: {
    url: process.env.DATABASE_URL || 'postgresql://appstore:appstore_pass@localhost:5432/appstore',
  },

  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },

  elasticsearch: {
    url: process.env.ELASTICSEARCH_URL || 'http://localhost:9200',
  },

  minio: {
    endpoint: process.env.MINIO_ENDPOINT || 'localhost',
    port: parseInt(process.env.MINIO_PORT || '9000', 10),
    accessKey: process.env.MINIO_ACCESS_KEY || 'minio_admin',
    secretKey: process.env.MINIO_SECRET_KEY || 'minio_password',
    useSSL: process.env.MINIO_USE_SSL === 'true',
    buckets: {
      packages: 'app-packages',
      screenshots: 'screenshots',
      icons: 'icons',
    },
  },

  session: {
    secret: process.env.SESSION_SECRET || 'dev-secret-change-in-prod',
  },

  api: {
    version: process.env.API_VERSION || 'v1',
  },
};
