import express from 'express';
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
app.use(express.json({ limit: '10mb' }));

if (config.nodeEnv !== 'test') {
  app.use(pinoHttp({ logger }));
}

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

// Health check
app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: 'unhealthy', timestamp: new Date().toISOString() });
  }
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

// Errors raised by middleware rather than route handlers. Without this,
// Express's default handler answered a malformed JSON body or an oversized
// upload with an HTML 500 page.
app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  const e = err as { type?: string; code?: string };
  if (e.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'Malformed JSON body' });
    return;
  }
  if (e.code === 'LIMIT_FILE_SIZE') {
    res.status(413).json({ error: 'File too large (max 50MB)' });
    return;
  }
  logger.error({ err }, 'Unhandled error');
  res.status(500).json({ error: 'Internal server error' });
});
