export default {
  database: {
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME || 'shopify',
    user: process.env.DB_USER || 'shopify',
    password: process.env.DB_PASSWORD || 'shopify_password',
  },
  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },
  server: {
    port: process.env.PORT || 3001,
    sessionSecret: process.env.SESSION_SECRET || 'shopify-dev-secret-change-in-production',
  },
  platform: {
    domain: process.env.PLATFORM_DOMAIN || 'localhost:3001',
    storefrontDomain: process.env.STOREFRONT_DOMAIN || 'localhost:5173',
  },
};
