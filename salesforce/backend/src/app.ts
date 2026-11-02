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
import dashboardRoutes from './routes/dashboard.js';
import accountRoutes from './routes/accounts.js';
import contactRoutes from './routes/contacts.js';
import opportunityRoutes from './routes/opportunities.js';
import leadRoutes from './routes/leads.js';
import activityRoutes from './routes/activities.js';
import reportRoutes from './routes/reports.js';

/** Express application for the Salesforce CRM backend with session auth, rate limiting, and CRUD routes. */
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

// Request metrics. The histogram and counter were registered but nothing ever
// observed them, so /metrics exported only process defaults. The route label is
// the matched pattern (/api/accounts/:id), not the raw URL, to keep label
// cardinality bounded.
app.use((req, res, next) => {
  const end = httpRequestDuration.startTimer();
  res.on('finish', () => {
    const route = req.route
      ? `${req.baseUrl}${req.route.path === '/' ? '' : req.route.path}` || '/'
      : 'unmatched';
    const labels = { method: req.method, route, status_code: String(res.statusCode) };
    end(labels);
    httpRequestTotal.inc(labels);
  });
  next();
});

// Session
const redisStore = new RedisStore({
  client: redis,
  prefix: 'salesforce:session:',
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
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/accounts', accountRoutes);
app.use('/api/contacts', contactRoutes);
app.use('/api/opportunities', opportunityRoutes);
app.use('/api/leads', leadRoutes);
app.use('/api/activities', activityRoutes);
app.use('/api/reports', reportRoutes);
