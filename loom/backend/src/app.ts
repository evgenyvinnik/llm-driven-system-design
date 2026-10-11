import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import session from 'express-session';
import RedisStore from 'connect-redis';
import pinoHttpModule from 'pino-http';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pinoHttp = (pinoHttpModule as any).pinoHttp || (pinoHttpModule as any).default || pinoHttpModule;
import { config } from './config/index.js';
import { redis } from './services/redis.js';
import { logger, redactUrl } from './services/logger.js';
import { register, httpMetricsMiddleware } from './services/metrics.js';
import { apiLimiter } from './services/rateLimiter.js';
import { pool } from './services/db.js';
import authRoutes from './routes/auth.js';
import videoRoutes from './routes/videos.js';
import uploadRoutes from './routes/upload.js';
import commentRoutes from './routes/comments.js';
import shareRoutes from './routes/shares.js';
import analyticsRoutes from './routes/analytics.js';
import folderRoutes from './routes/folders.js';

/** Express application with session auth, rate limiting, and video platform routes. */
export const app = express();

app.set('trust proxy', config.trustProxy);

// Middleware
app.use(
  cors({
    origin: config.cors.origin,
    credentials: config.cors.credentials,
  }),
);
// JSON bodies are metadata only; video bytes go straight to object storage.
app.use(express.json({ limit: '100kb' }));

if (config.nodeEnv !== 'test') {
  app.use(
    pinoHttp({
      logger,
      serializers: {
        // Log the route, not the capability: share tokens are masked and query strings dropped.
        req: (req: { id?: unknown; method?: string; url?: string; remoteAddress?: string }) => ({
          id: req.id,
          method: req.method,
          url: redactUrl(req.url),
          remoteAddress: req.remoteAddress,
        }),
      },
    }),
  );
}
app.use(httpMetricsMiddleware);

// Liveness: the process is up. Readiness: it can reach what it needs to serve requests.
app.get('/api/health/live', (_req, res) => {
  res.json({ status: 'ok' });
});

async function readiness(_req: Request, res: Response) {
  const checks: Record<string, string> = {};
  try {
    await pool.query('SELECT 1');
    checks.postgres = 'ok';
  } catch {
    checks.postgres = 'down';
  }
  try {
    await redis.ping();
    checks.redis = 'ok';
  } catch {
    checks.redis = 'down';
  }
  const ok = Object.values(checks).every((value) => value === 'ok');
  res.status(ok ? 200 : 503).json({
    status: ok ? 'ok' : 'unhealthy',
    checks,
    timestamp: new Date().toISOString(),
  });
}
app.get('/api/health/ready', readiness);
app.get('/api/health', readiness);

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
  prefix: 'loom:session:',
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
app.use('/api/videos', videoRoutes);
app.use('/api/videos', commentRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/share', shareRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/folders', folderRoutes);

// Errors that reach here (a failed rate-limit store, a broken session store) answer in
// JSON like every route does, instead of Express's default HTML page.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  logger.error({ err }, 'Unhandled request error');
  if (res.headersSent) return;
  // Body-parser errors (malformed JSON, oversized body) carry a 4xx status and a safe message.
  const { status, expose, message } = (err ?? {}) as { status?: number; expose?: boolean; message?: string };
  if (typeof status === 'number' && status >= 400 && status < 500) {
    res.status(status).json({ error: expose && message ? message : 'Bad request' });
    return;
  }
  // Route handlers catch their own failures, so what arrives here is a dependency
  // failing inside middleware: the session store, a rate-limit store, an access check.
  res.status(503).json({ error: 'Service temporarily unavailable' });
});
