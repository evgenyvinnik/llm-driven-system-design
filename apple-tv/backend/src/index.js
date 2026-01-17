const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const RedisStore = require('connect-redis').default;

const config = require('./config');
const db = require('./db');
const { client: redisClient, connect: connectRedis } = require('./db/redis');
const { initBuckets } = require('./db/minio');

// Routes
const authRoutes = require('./routes/auth');
const contentRoutes = require('./routes/content');
const streamingRoutes = require('./routes/streaming');
const watchProgressRoutes = require('./routes/watchProgress');
const watchlistRoutes = require('./routes/watchlist');
const subscriptionRoutes = require('./routes/subscription');
const recommendationsRoutes = require('./routes/recommendations');
const adminRoutes = require('./routes/admin');

const app = express();

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true
}));
app.use(express.json());
app.use(cookieParser());

// Initialize function
async function init() {
  // Connect to Redis
  await connectRedis();

  // Initialize MinIO buckets
  try {
    await initBuckets();
    console.log('MinIO buckets initialized');
  } catch (error) {
    console.warn('MinIO initialization warning:', error.message);
  }

  // Session middleware with Redis store
  app.use(session({
    store: new RedisStore({ client: redisClient }),
    secret: config.session.secret,
    name: config.session.name,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      maxAge: config.session.maxAge,
      sameSite: 'lax'
    }
  }));

  // Health check
  app.get('/health', async (req, res) => {
    try {
      await db.query('SELECT 1');
      await redisClient.ping();
      res.json({ status: 'healthy', timestamp: new Date().toISOString() });
    } catch (error) {
      res.status(500).json({ status: 'unhealthy', error: error.message });
    }
  });

  // API routes
  app.use('/api/auth', authRoutes);
  app.use('/api/content', contentRoutes);
  app.use('/api/stream', streamingRoutes);
  app.use('/api/watch', watchProgressRoutes);
  app.use('/api/watchlist', watchlistRoutes);
  app.use('/api/subscription', subscriptionRoutes);
  app.use('/api/recommendations', recommendationsRoutes);
  app.use('/api/admin', adminRoutes);

  // Error handling middleware
  app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  // Start server
  const port = config.port;
  app.listen(port, () => {
    console.log(`Apple TV+ backend running on port ${port}`);
    console.log(`Health check: http://localhost:${port}/health`);
  });
}

// Handle graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down...');
  await redisClient.quit();
  await db.pool.end();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down...');
  await redisClient.quit();
  await db.pool.end();
  process.exit(0);
});

// Start the server
init().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
