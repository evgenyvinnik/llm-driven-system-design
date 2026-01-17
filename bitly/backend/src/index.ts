import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';

import { SERVER_CONFIG, RATE_LIMIT_CONFIG } from './config.js';
import { testConnection, closePool } from './utils/database.js';
import { closeRedis } from './utils/cache.js';
import { initKeyService } from './services/keyService.js';
import { errorHandler, notFoundHandler, requestLogger } from './middleware/errorHandler.js';

import authRoutes from './routes/auth.js';
import urlRoutes from './routes/urls.js';
import analyticsRoutes from './routes/analytics.js';
import adminRoutes from './routes/admin.js';
import redirectRoutes from './routes/redirect.js';

const app = express();

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false, // Disable for development
}));

// CORS
app.use(cors({
  origin: SERVER_CONFIG.corsOrigin,
  credentials: true,
}));

// Body parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Cookie parsing
app.use(cookieParser());

// Request logging
app.use(requestLogger);

// Rate limiting
const generalLimiter = rateLimit({
  windowMs: RATE_LIMIT_CONFIG.general.windowMs,
  max: RATE_LIMIT_CONFIG.general.max,
  message: { error: 'Too many requests, please try again later' },
});

const createUrlLimiter = rateLimit({
  windowMs: RATE_LIMIT_CONFIG.createUrl.windowMs,
  max: RATE_LIMIT_CONFIG.createUrl.max,
  message: { error: 'Too many URLs created, please try again later' },
});

// Apply general rate limit to API routes
app.use('/api', generalLimiter);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API routes
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/urls', urlRoutes);
app.use('/api/v1/analytics', analyticsRoutes);
app.use('/api/v1/admin', adminRoutes);

// Apply stricter rate limit to URL creation
app.post('/api/v1/urls', createUrlLimiter);

// Redirect route (must be last - catches /:shortCode)
app.use('/', redirectRoutes);

// Error handling
app.use(notFoundHandler);
app.use(errorHandler);

// Graceful shutdown
async function shutdown(signal: string): Promise<void> {
  console.log(`\n${signal} received. Shutting down gracefully...`);

  try {
    await closePool();
    await closeRedis();
    console.log('Cleanup complete. Exiting.');
    process.exit(0);
  } catch (error) {
    console.error('Error during shutdown:', error);
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Start server
async function start(): Promise<void> {
  try {
    // Test database connection
    const dbConnected = await testConnection();
    if (!dbConnected) {
      console.error('Failed to connect to database. Exiting.');
      process.exit(1);
    }

    // Initialize key service
    await initKeyService();

    // Start listening
    app.listen(SERVER_CONFIG.port, SERVER_CONFIG.host, () => {
      console.log(`Server running at http://${SERVER_CONFIG.host}:${SERVER_CONFIG.port}`);
      console.log(`Base URL: ${SERVER_CONFIG.baseUrl}`);
      console.log(`CORS Origin: ${SERVER_CONFIG.corsOrigin}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();
