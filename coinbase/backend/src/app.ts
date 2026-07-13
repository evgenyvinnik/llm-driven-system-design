import express from 'express';
import cors from 'cors';
import session from 'express-session';
import { RedisStore } from 'connect-redis';
import { redis } from './services/redis.js';
import { config } from './config/index.js';
import { apiLimiter } from './services/rateLimiter.js';
import { register, httpRequestDuration } from './services/metrics.js';
import authRoutes from './routes/auth.js';
import marketsRoutes from './routes/markets.js';
import ordersRoutes from './routes/orders.js';
import portfolioRoutes from './routes/portfolio.js';
import walletsRoutes from './routes/wallets.js';
import transactionsRoutes from './routes/transactions.js';

/** Express application instance with session auth, rate limiting, and API routes. */
export const app = express();

// Middleware
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// Session
const redisStore = new RedisStore({ client: redis, prefix: 'coinbase:sess:' });
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
  })
);

// Request duration tracking
app.use((req, res, next) => {
  const end = httpRequestDuration.startTimer();
  res.on('finish', () => {
    end({
      method: req.method,
      route: req.route?.path || req.path,
      status_code: res.statusCode,
    });
  });
  next();
});

// Rate limiting
app.use('/api', apiLimiter);

// Health check
app.get('/api/v1/health', (_req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// Metrics endpoint
app.get('/metrics', async (_req, res) => {
  try {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (_err) {
    res.status(500).end();
  }
});

// API routes
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/markets', marketsRoutes);
app.use('/api/v1/orders', ordersRoutes);
app.use('/api/v1/portfolio', portfolioRoutes);
app.use('/api/v1/wallets', walletsRoutes);
app.use('/api/v1/transactions', transactionsRoutes);

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});
