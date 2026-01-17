import express from 'express';
import cors from 'cors';
import session from 'express-session';
import RedisStore from 'connect-redis';
import dotenv from 'dotenv';
import redis from './db/redis.js';

import authRoutes from './routes/auth.js';
import usersRoutes from './routes/users.js';
import tweetsRoutes from './routes/tweets.js';
import timelineRoutes from './routes/timeline.js';
import trendsRoutes from './routes/trends.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors({
  origin: ['http://localhost:5173', 'http://localhost:5174'],
  credentials: true,
}));
app.use(express.json());

// Session configuration with Redis store
const redisStore = new RedisStore({
  client: redis,
  prefix: 'twitter:session:',
});

app.use(session({
  store: redisStore,
  secret: process.env.SESSION_SECRET || 'twitter-session-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 1000 * 60 * 60 * 24 * 7, // 1 week
  },
}));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/tweets', tweetsRoutes);
app.use('/api/timeline', timelineRoutes);
app.use('/api/trends', trendsRoutes);

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.listen(PORT, () => {
  console.log(`Twitter API server running on port ${PORT}`);
});

export default app;
