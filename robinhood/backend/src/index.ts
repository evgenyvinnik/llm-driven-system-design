import express from 'express';
import cors from 'cors';
import http from 'http';
import { config } from './config.js';
import { testDatabaseConnection } from './database.js';
import { testRedisConnection } from './redis.js';
import { quoteService } from './services/quoteService.js';
import { orderService } from './services/orderService.js';
import { priceAlertService } from './services/watchlistService.js';
import { WebSocketHandler } from './websocket.js';

// Routes
import authRoutes from './routes/auth.js';
import quotesRoutes from './routes/quotes.js';
import ordersRoutes from './routes/orders.js';
import portfolioRoutes from './routes/portfolio.js';
import watchlistsRoutes from './routes/watchlists.js';

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Health check
app.get('/health', async (_req, res) => {
  const dbHealthy = await testDatabaseConnection();
  const redisHealthy = await testRedisConnection();

  res.json({
    status: dbHealthy && redisHealthy ? 'healthy' : 'unhealthy',
    database: dbHealthy ? 'connected' : 'disconnected',
    redis: redisHealthy ? 'connected' : 'disconnected',
    timestamp: new Date().toISOString(),
  });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/quotes', quotesRoutes);
app.use('/api/orders', ordersRoutes);
app.use('/api/portfolio', portfolioRoutes);
app.use('/api/watchlists', watchlistsRoutes);

// Create HTTP server
const server = http.createServer(app);

// Initialize WebSocket handler
const wsHandler = new WebSocketHandler(server);

// Start services
async function startServer(): Promise<void> {
  // Test connections
  const dbConnected = await testDatabaseConnection();
  if (!dbConnected) {
    console.error('Failed to connect to database. Make sure PostgreSQL is running.');
    console.error('Run: docker-compose up -d');
  }

  const redisConnected = await testRedisConnection();
  if (!redisConnected) {
    console.error('Failed to connect to Redis. Make sure Redis is running.');
    console.error('Run: docker-compose up -d');
  }

  // Start quote service
  quoteService.start(config.quotes.updateIntervalMs);

  // Start order matcher for limit orders
  orderService.startLimitOrderMatcher();

  // Start price alert checker
  priceAlertService.startAlertChecker();

  // Start HTTP server
  server.listen(config.port, () => {
    console.log(`
╔════════════════════════════════════════════════════════════════╗
║                  Robinhood Trading Platform                     ║
╠════════════════════════════════════════════════════════════════╣
║  HTTP Server:     http://localhost:${config.port}                      ║
║  WebSocket:       ws://localhost:${config.port}/ws                     ║
║  Database:        ${dbConnected ? 'Connected' : 'Disconnected'}                                     ║
║  Redis:           ${redisConnected ? 'Connected' : 'Disconnected'}                                     ║
╠════════════════════════════════════════════════════════════════╣
║  Demo Credentials:                                              ║
║    Email:    demo@example.com                                   ║
║    Password: password                                           ║
╚════════════════════════════════════════════════════════════════╝
    `);
  });
}

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down...');
  quoteService.stop();
  orderService.stopLimitOrderMatcher();
  priceAlertService.stopAlertChecker();
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received. Shutting down...');
  quoteService.stop();
  orderService.stopLimitOrderMatcher();
  priceAlertService.stopAlertChecker();
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

startServer().catch(console.error);

export { app, server, wsHandler };
