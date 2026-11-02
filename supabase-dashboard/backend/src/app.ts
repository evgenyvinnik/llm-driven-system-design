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
import { register, httpRequestDuration, httpRequestTotal } from './services/metrics.js';
import { apiLimiter } from './services/rateLimiter.js';
import { pool } from './services/db.js';
import authRoutes from './routes/auth.js';
import projectRoutes from './routes/projects.js';
import tableRoutes from './routes/tables.js';
import tableDataRoutes from './routes/tableData.js';
import sqlRoutes from './routes/sql.js';
import authUserRoutes from './routes/authUsers.js';
import settingsRoutes from './routes/settings.js';
import userRoutes from './routes/users.js';

/** Express application for the Supabase dashboard with session auth and project routes. */
export const app = express();

// Middleware
app.use(
  cors({
    origin: config.cors.origin,
    credentials: config.cors.credentials,
  }),
);
app.use(express.json({ limit: '10mb' }));

// HTTP metrics, labelled by route template (not the raw URL) so project IDs and
// table names don't create a time series each.
app.use((req, res, next) => {
  const end = httpRequestDuration.startTimer();
  res.on('finish', () => {
    const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : 'unmatched';
    const labels = { method: req.method, route, status_code: String(res.statusCode) };
    end(labels);
    httpRequestTotal.inc(labels);
  });
  next();
});

if (config.nodeEnv !== 'test') {
  app.use(pinoHttp({ logger }));
}

// Session
const redisStore = new RedisStore({
  client: redis,
  prefix: 'supabase:session:',
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
app.use('/api/projects', projectRoutes);
app.use('/api/projects', tableRoutes);
app.use('/api/projects', tableDataRoutes);
app.use('/api/projects', sqlRoutes);
app.use('/api/projects', authUserRoutes);
app.use('/api/projects', settingsRoutes);
app.use('/api/users', userRoutes);
