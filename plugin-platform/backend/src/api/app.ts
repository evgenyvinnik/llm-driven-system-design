import express from 'express';
import cors from 'cors';
import session from 'express-session';
import { RedisStore } from 'connect-redis';
import pinoHttp from 'pino-http';
import { redis } from '../shared/cache.js';
import { logger } from '../shared/logger.js';
import { authRouter, requireAuth, optionalAuth } from './routes/auth.js';
import { pluginsRouter } from './routes/plugins.js';
import { userPluginsRouter } from './routes/user-plugins.js';
import { developerRouter } from './routes/developer.js';

export const app = express();

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json());
app.use(pinoHttp({ logger }));

// Session configuration
const redisStore = new RedisStore({ client: redis });

app.use(session({
  store: redisStore,
  secret: process.env.SESSION_SECRET || 'plugin-platform-dev-secret',
  resave: false,
  saveUninitialized: true, // Allow anonymous sessions
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  },
}));

// Ensure session has an ID for anonymous users
app.use((req, _res, next) => {
  if (!req.session.anonymousId && !req.session.userId) {
    req.session.anonymousId = req.sessionID;
  }
  next();
});

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API routes
app.use('/api/v1/auth', authRouter);
app.use('/api/v1/plugins', optionalAuth, pluginsRouter);
app.use('/api/v1/user/plugins', optionalAuth, userPluginsRouter);
app.use('/api/v1/developer', requireAuth, developerRouter);

// Error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error(err, 'Unhandled error');
  res.status(500).json({ error: 'Internal server error' });
});

// Extend session types
declare module 'express-session' {
  interface SessionData {
    userId?: string;
    anonymousId?: string;
  }
}
