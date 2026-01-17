import express from 'express';
import cors from 'cors';
import session from 'express-session';
import RedisStore from 'connect-redis';
import redis from './db/redis.js';

// Routes
import authRoutes from './routes/auth.js';
import deviceRoutes from './routes/devices.js';
import locationRoutes from './routes/locations.js';
import lostModeRoutes from './routes/lostMode.js';
import notificationRoutes from './routes/notifications.js';
import antiStalkingRoutes from './routes/antiStalking.js';
import adminRoutes from './routes/admin.js';

const app = express();
const PORT = parseInt(process.env.PORT || '3000');

// Middleware
app.use(
  cors({
    origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
    credentials: true,
  })
);
app.use(express.json());

// Session configuration
const redisStore = new RedisStore({
  client: redis,
  prefix: 'findmy:session:',
});

app.use(
  session({
    store: redisStore,
    secret: process.env.SESSION_SECRET || 'findmy-dev-secret-change-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
    },
  })
);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/devices', deviceRoutes);
app.use('/api/locations', locationRoutes);
app.use('/api/lost-mode', lostModeRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/anti-stalking', antiStalkingRoutes);
app.use('/api/admin', adminRoutes);

// Error handling
app.use(
  (
    err: Error,
    req: express.Request,
    res: express.Response,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    next: express.NextFunction
  ) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Start server
app.listen(PORT, () => {
  console.log(`Find My Network server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});

export default app;
