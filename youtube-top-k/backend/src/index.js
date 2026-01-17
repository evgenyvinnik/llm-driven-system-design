import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import { initializeDatabase } from './models/database.js';
import { initializeRedis } from './services/redis.js';
import { TrendingService } from './services/trendingService.js';
import videoRoutes from './routes/videos.js';
import trendingRoutes from './routes/trending.js';
import sseRoutes from './routes/sse.js';

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Request logging
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Routes
app.use('/api/videos', videoRoutes);
app.use('/api/trending', trendingRoutes);
app.use('/api/sse', sseRoutes);

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ error: 'Internal server error', message: err.message });
});

// Initialize services and start server
async function start() {
  try {
    console.log('Initializing database...');
    await initializeDatabase();

    console.log('Initializing Redis...');
    await initializeRedis();

    console.log('Starting trending service...');
    const trendingService = TrendingService.getInstance();
    await trendingService.start();

    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
      console.log(`Health check: http://localhost:${PORT}/health`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();
