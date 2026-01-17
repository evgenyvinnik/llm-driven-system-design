import express from 'express';
import cors from 'cors';
import session from 'express-session';
import { RedisStore } from 'connect-redis';
import cookieParser from 'cookie-parser';

import { initializeDatabase, redisClient } from './db.js';
import { migrate } from './models/migrate.js';

import authRoutes from './routes/auth.js';
import catalogRoutes from './routes/catalog.js';
import libraryRoutes from './routes/library.js';
import playlistRoutes from './routes/playlists.js';
import playbackRoutes from './routes/playback.js';
import recommendationsRoutes from './routes/recommendations.js';

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json());
app.use(cookieParser());

// Initialize server
async function startServer() {
  try {
    // Initialize database connections
    await initializeDatabase();

    // Run migrations
    await migrate();

    // Session store with Redis
    const redisStore = new RedisStore({
      client: redisClient,
      prefix: 'spotify:session:',
    });

    app.use(session({
      store: redisStore,
      secret: process.env.SESSION_SECRET || 'spotify-dev-secret-change-in-prod',
      resave: false,
      saveUninitialized: false,
      cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      },
    }));

    // Health check
    app.get('/health', (req, res) => {
      res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });

    // API Routes
    app.use('/api/auth', authRoutes);
    app.use('/api/catalog', catalogRoutes);
    app.use('/api/library', libraryRoutes);
    app.use('/api/playlists', playlistRoutes);
    app.use('/api/playback', playbackRoutes);
    app.use('/api/recommendations', recommendationsRoutes);

    // Error handling middleware
    app.use((err, req, res, next) => {
      console.error('Unhandled error:', err);
      res.status(500).json({ error: 'Internal server error' });
    });

    // 404 handler
    app.use((req, res) => {
      res.status(404).json({ error: 'Not found' });
    });

    app.listen(PORT, () => {
      console.log(`Spotify backend running on port ${PORT}`);
      console.log(`Health check: http://localhost:${PORT}/health`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
