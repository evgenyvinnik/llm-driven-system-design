import express from 'express';
import cors from 'cors';
import { config } from './config/index.js';
import { initializeDatabase } from './config/database.js';
import authRoutes from './routes/auth.js';
import deviceRoutes from './routes/devices.js';
import healthRoutes from './routes/health.js';
import adminRoutes from './routes/admin.js';

const app = express();

// Middleware
app.use(cors({
  origin: config.cors.origin,
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API Routes
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/devices', deviceRoutes);
app.use('/api/v1/health', healthRoutes);
app.use('/api/v1/admin', adminRoutes);

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Start server
async function start() {
  const dbConnected = await initializeDatabase();
  if (!dbConnected) {
    console.error('Failed to connect to database. Exiting...');
    process.exit(1);
  }

  app.listen(config.port, () => {
    console.log(`Health Data Pipeline API running on port ${config.port}`);
    console.log(`Environment: ${config.nodeEnv}`);
  });
}

start();
