import express from 'express';
import cors from 'cors';
import session from 'express-session';
import { testDatabaseConnection, testRedisConnection, redis } from './db/index.js';

// Import routes
import authRoutes from './routes/auth.js';
import meetingTypesRoutes from './routes/meetingTypes.js';
import availabilityRoutes from './routes/availability.js';
import bookingsRoutes from './routes/bookings.js';
import adminRoutes from './routes/admin.js';

// Redis session store
import RedisStore from 'connect-redis';

/**
 * Express application for the Calendly API server.
 * Provides RESTful endpoints for scheduling and booking management.
 */
const app = express();

/** Server port from environment or default to 3001 */
const PORT = process.env.PORT || 3001;

// CORS configuration for frontend requests
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
}));

// Parse JSON request bodies
app.use(express.json());

/**
 * Redis-backed session store.
 * Sessions are prefixed with 'calendly:session:' in Redis.
 */
const redisStore = new RedisStore({
  client: redis,
  prefix: 'calendly:session:',
});

/**
 * Session middleware configuration.
 * Uses Redis for session storage with secure cookie settings.
 */
app.use(session({
  store: redisStore,
  secret: process.env.SESSION_SECRET || 'calendly-secret-key-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    sameSite: 'lax',
  },
}));

/**
 * Health check endpoint.
 * Returns status of database and Redis connections.
 */
app.get('/health', async (req, res) => {
  const dbHealthy = await testDatabaseConnection();
  const redisHealthy = await testRedisConnection();

  res.status(dbHealthy && redisHealthy ? 200 : 503).json({
    status: dbHealthy && redisHealthy ? 'healthy' : 'unhealthy',
    database: dbHealthy ? 'connected' : 'disconnected',
    redis: redisHealthy ? 'connected' : 'disconnected',
  });
});

// Mount API route handlers
app.use('/api/auth', authRoutes);
app.use('/api/meeting-types', meetingTypesRoutes);
app.use('/api/availability', availabilityRoutes);
app.use('/api/bookings', bookingsRoutes);
app.use('/api/admin', adminRoutes);

/**
 * Global error handler for unhandled errors.
 * Logs the error and returns a generic 500 response.
 */
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
  });
});

/**
 * 404 handler for unmatched routes.
 */
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Not found',
  });
});

/**
 * Initializes and starts the API server.
 * Tests database and Redis connections before listening.
 */
async function start() {
  console.log('Starting Calendly API server...');

  // Test connections
  const dbConnected = await testDatabaseConnection();
  const redisConnected = await testRedisConnection();

  if (!dbConnected) {
    console.warn('Warning: Database connection failed. Some features may not work.');
  }

  if (!redisConnected) {
    console.warn('Warning: Redis connection failed. Sessions and caching may not work.');
  }

  app.listen(PORT, () => {
    console.log(`Calendly API server running on http://localhost:${PORT}`);
    console.log(`Health check available at http://localhost:${PORT}/health`);
  });
}

start().catch(console.error);

export default app;
