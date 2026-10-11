import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import session from 'express-session';
import RedisStore from 'connect-redis';
import pinoHttpModule from 'pino-http';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pinoHttp = (pinoHttpModule as any).pinoHttp || (pinoHttpModule as any).default || pinoHttpModule;
import { config } from './config/index.js';
import { redis } from './services/redis.js';
import { logger } from './services/logger.js';
import { register } from './services/metrics.js';
import { apiLimiter } from './services/rateLimiter.js';
import { pool } from './services/db.js';
import { getStreamStats } from './services/sseService.js';
import { httpMetrics } from './middleware/httpMetrics.js';
import authRoutes from './routes/auth.js';
import organizationRoutes from './routes/organizations.js';
import teamRoutes from './routes/teams.js';
import channelRoutes from './routes/channels.js';
import messageRoutes from './routes/messages.js';
import reactionRoutes from './routes/reactions.js';
import fileRoutes from './routes/files.js';
import presenceRoutes from './routes/presence.js';
import sseRoutes from './routes/sse.js';
import userRoutes from './routes/users.js';

/** Express application with session auth, SSE, and enterprise chat platform routes. */
export const app = express();

// Middleware
app.use(
  cors({
    origin: config.cors.origin,
    credentials: config.cors.credentials,
  }),
);
// Messages are capped at 10,000 characters; nothing legitimate needs a larger JSON body.
app.use(express.json({ limit: '256kb' }));

if (config.nodeEnv !== 'test') {
  app.use(pinoHttp({ logger }));
}
app.use(httpMetrics);

// Health and metrics are registered before the session and rate-limit middleware, so probes
// neither create sessions nor spend a client's request budget.

// Liveness: the process is up. No dependency checks, so a database outage does not get every
// instance restarted at once.
app.get('/api/health/live', (_req, res) => {
  res.json({ status: 'ok' });
});

// Readiness: the dependencies needed to serve traffic answer. A load balancer stops routing new
// requests to an instance that returns 503 here.
app.get('/api/health', async (_req, res) => {
  const timeout = new Promise<never>((_resolve, reject) =>
    setTimeout(() => reject(new Error('timeout')), 1000).unref(),
  );
  const [database, cache] = await Promise.allSettled([
    Promise.race([pool.query('SELECT 1'), timeout]),
    Promise.race([redis.ping(), timeout]),
  ]);
  const checks = {
    database: database.status === 'fulfilled',
    redis: cache.status === 'fulfilled',
  };
  const ready = checks.database && checks.redis;
  res.status(ready ? 200 : 503).json({
    status: ready ? 'ok' : 'unhealthy',
    checks,
    streams: getStreamStats(),
    timestamp: new Date().toISOString(),
  });
});

// Metrics
app.get('/metrics', async (_req, res) => {
  try {
    const metrics = await register.metrics();
    res.set('Content-Type', register.contentType);
    res.end(metrics);
  } catch {
    res.status(500).end();
  }
});

// Session
const redisStore = new RedisStore({
  client: redis,
  prefix: 'teams:session:',
});

app.use(
  session({
    store: redisStore,
    secret: config.session.secret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: config.session.maxAge,
      httpOnly: true,
      secure: config.nodeEnv === 'production',
      sameSite: 'lax',
    },
  }),
);

// Rate limiting
app.use('/api', apiLimiter);

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/organizations', organizationRoutes);
app.use('/api/teams', teamRoutes);
app.use('/api/channels', channelRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/reactions', reactionRoutes);
app.use('/api/files', fileRoutes);
app.use('/api/presence', presenceRoutes);
app.use('/api/sse', sseRoutes);
app.use('/api/users', userRoutes);

// Errors passed to next() (from the access middleware, or a malformed JSON body) end up here.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status = (err as { status?: unknown }).status;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    res.status(status).json({ error: 'Invalid request' });
    return;
  }
  logger.error({ err }, 'Unhandled request error');
  if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
});
