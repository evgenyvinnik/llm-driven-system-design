import express from 'express';
import cors from 'cors';
import session from 'express-session';
import { RedisStore } from 'connect-redis';
import { pinoHttp } from 'pino-http';
import { redis } from './services/redis.js';
import { logger } from './services/logger.js';
import { config } from './config/index.js';
import { metricsRegistry } from './services/metrics.js';
import { apiLimiter } from './services/rateLimiter.js';
import authRoutes from './routes/auth.js';
import meetingsRoutes from './routes/meetings.js';
import roomsRoutes from './routes/rooms.js';
import chatRoutes from './routes/chat.js';

export const app = express();

// Middleware
app.use(cors({
  origin: 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json());
app.use(pinoHttp({ logger }));

// Session
const redisStore = new RedisStore({
  client: redis,
  prefix: 'zoom:session:',
});

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

// Rate limiting
app.use('/api/', apiLimiter);

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Metrics endpoint
app.get('/api/metrics', async (_req, res) => {
  try {
    const metrics = await metricsRegistry.metrics();
    res.set('Content-Type', metricsRegistry.contentType);
    res.end(metrics);
  } catch (err) {
    logger.error({ err }, 'Metrics error');
    res.status(500).json({ error: 'Failed to collect metrics' });
  }
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/meetings', meetingsRoutes);
app.use('/api/rooms', roomsRoutes);
app.use('/api/chat', chatRoutes);

// Error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error({ err }, 'Unhandled error');
  res.status(500).json({ error: 'Internal server error' });
});
