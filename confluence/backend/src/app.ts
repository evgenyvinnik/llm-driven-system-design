import express from 'express';
import cors from 'cors';
import session from 'express-session';
import { RedisStore } from 'connect-redis';
import pinoHttp from 'pino-http';
import { redis } from './services/redis.js';
import { config } from './config/index.js';
import { logger } from './services/logger.js';
import { apiLimiter } from './services/rateLimiter.js';
import { register, httpRequestDuration, httpRequestTotal } from './services/metrics.js';

import authRoutes from './routes/auth.js';
import spaceRoutes from './routes/spaces.js';
import pageRoutes from './routes/pages.js';
import versionRoutes from './routes/versions.js';
import searchRoutes from './routes/search.js';
import templateRoutes from './routes/templates.js';
import commentRoutes from './routes/comments.js';
import approvalRoutes from './routes/approvals.js';

/** Express application with session auth, rate limiting, and Prometheus metrics. */
export const app = express();

// Middleware
app.use(cors({
  origin: 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json({ limit: '5mb' }));

if (config.nodeEnv !== 'test') {
  app.use(pinoHttp({ logger }));
}

// Session
const redisStore = new RedisStore({ client: redis });
app.use(
  session({
    store: redisStore,
    secret: config.session.secret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: false,
      httpOnly: true,
      maxAge: config.session.maxAge,
      sameSite: 'lax',
    },
  }),
);

// Rate limiting
app.use('/api', apiLimiter);

// Request metrics
app.use((req, res, next) => {
  const end = httpRequestDuration.startTimer();
  res.on('finish', () => {
    const route = req.route?.path || req.path;
    end({ method: req.method, route, status_code: res.statusCode });
    httpRequestTotal.inc({
      method: req.method,
      route,
      status_code: res.statusCode,
    });
  });
  next();
});

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Metrics endpoint
app.get('/api/metrics', async (_req, res) => {
  try {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (err) {
    logger.error({ err }, 'Metrics error');
    res.status(500).end();
  }
});

// Routes
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/spaces', spaceRoutes);
app.use('/api/v1/pages', pageRoutes);
app.use('/api/v1/versions', versionRoutes);
app.use('/api/v1/search', searchRoutes);
app.use('/api/v1/templates', templateRoutes);
app.use('/api/v1/comments', commentRoutes);
app.use('/api/v1/approvals', approvalRoutes);
