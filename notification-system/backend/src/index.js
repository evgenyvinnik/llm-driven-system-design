import express from 'express';
import cors from 'cors';
import { pool, initDatabase } from './utils/database.js';
import { redis } from './utils/redis.js';
import { initRabbitMQ } from './utils/rabbitmq.js';
import authRoutes from './routes/auth.js';
import notificationRoutes from './routes/notifications.js';
import preferenceRoutes from './routes/preferences.js';
import templateRoutes from './routes/templates.js';
import campaignRoutes from './routes/campaigns.js';
import adminRoutes from './routes/admin.js';
import { authMiddleware } from './middleware/auth.js';

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors({
  origin: ['http://localhost:5173', 'http://localhost:5174'],
  credentials: true
}));
app.use(express.json());

// Health check
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    await redis.ping();
    res.json({ status: 'healthy', timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ status: 'unhealthy', error: error.message });
  }
});

// Public routes
app.use('/api/v1/auth', authRoutes);

// Protected routes
app.use('/api/v1/notifications', authMiddleware, notificationRoutes);
app.use('/api/v1/preferences', authMiddleware, preferenceRoutes);
app.use('/api/v1/templates', authMiddleware, templateRoutes);
app.use('/api/v1/campaigns', authMiddleware, campaignRoutes);
app.use('/api/v1/admin', authMiddleware, adminRoutes);

// Error handling
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

// Initialize and start
async function start() {
  try {
    // Initialize database connection
    await initDatabase();
    console.log('Database connected');

    // Initialize RabbitMQ
    await initRabbitMQ();
    console.log('RabbitMQ connected');

    app.listen(PORT, () => {
      console.log(`Notification API server running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();
