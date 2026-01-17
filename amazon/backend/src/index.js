import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { initializeDb } from './services/database.js';
import { initializeRedis } from './services/redis.js';
import { initializeElasticsearch } from './services/elasticsearch.js';
import authRoutes from './routes/auth.js';
import productRoutes from './routes/products.js';
import categoryRoutes from './routes/categories.js';
import cartRoutes from './routes/cart.js';
import orderRoutes from './routes/orders.js';
import reviewRoutes from './routes/reviews.js';
import searchRoutes from './routes/search.js';
import adminRoutes from './routes/admin.js';
import { authMiddleware } from './middleware/auth.js';
import { errorHandler } from './middleware/errorHandler.js';
import { startBackgroundJobs } from './services/backgroundJobs.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
  origin: ['http://localhost:5173', 'http://localhost:3000'],
  credentials: true
}));
app.use(express.json());

// Auth middleware (attaches user to req if authenticated)
app.use(authMiddleware);

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/products', productRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/cart', cartRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/reviews', reviewRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/admin', adminRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Error handler
app.use(errorHandler);

// Initialize services and start server
async function start() {
  try {
    console.log('Initializing database...');
    await initializeDb();

    console.log('Initializing Redis...');
    await initializeRedis();

    console.log('Initializing Elasticsearch...');
    await initializeElasticsearch();

    console.log('Starting background jobs...');
    startBackgroundJobs();

    app.listen(PORT, () => {
      console.log(`Amazon API server running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();
