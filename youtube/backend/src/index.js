import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import config from './config/index.js';

// Routes
import authRoutes from './routes/auth.js';
import uploadRoutes from './routes/upload.js';
import videoRoutes from './routes/videos.js';
import channelRoutes from './routes/channels.js';
import feedRoutes from './routes/feed.js';

// Utils
import { flushViewCounts } from './utils/redis.js';
import { query } from './utils/db.js';

const app = express();

// Middleware
app.use(cors(config.cors));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
  });
  next();
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API Routes
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/uploads', uploadRoutes);
app.use('/api/v1/videos', videoRoutes);
app.use('/api/v1/channels', channelRoutes);
app.use('/api/v1/feed', feedRoutes);

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Background job: Flush view counts to database
const startViewCountFlusher = () => {
  setInterval(async () => {
    try {
      const counts = await flushViewCounts();
      const videoIds = Object.keys(counts);

      if (videoIds.length > 0) {
        for (const [videoId, count] of Object.entries(counts)) {
          await query(
            'UPDATE videos SET view_count = view_count + $1 WHERE id = $2',
            [count, videoId]
          );
        }
        console.log(`Flushed view counts for ${videoIds.length} videos`);
      }
    } catch (error) {
      console.error('Failed to flush view counts:', error);
    }
  }, 60000); // Every minute
};

// Start server
const start = async () => {
  try {
    // Test database connection
    await query('SELECT 1');
    console.log('Database connected');

    // Start background jobs
    startViewCountFlusher();

    app.listen(config.port, () => {
      console.log(`Server running on port ${config.port}`);
      console.log(`API available at http://localhost:${config.port}/api/v1`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

start();
