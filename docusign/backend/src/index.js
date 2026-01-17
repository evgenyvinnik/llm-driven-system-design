import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { pool, initializeDatabase } from './utils/db.js';
import { redisClient, initializeRedis } from './utils/redis.js';
import { minioClient, initializeMinio } from './utils/minio.js';

import authRoutes from './routes/auth.js';
import envelopeRoutes from './routes/envelopes.js';
import documentRoutes from './routes/documents.js';
import recipientRoutes from './routes/recipients.js';
import fieldRoutes from './routes/fields.js';
import signingRoutes from './routes/signing.js';
import auditRoutes from './routes/audit.js';
import adminRoutes from './routes/admin.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors({
  origin: ['http://localhost:5173', 'http://localhost:3000'],
  credentials: true
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(cookieParser());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API Routes
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/envelopes', envelopeRoutes);
app.use('/api/v1/documents', documentRoutes);
app.use('/api/v1/recipients', recipientRoutes);
app.use('/api/v1/fields', fieldRoutes);
app.use('/api/v1/signing', signingRoutes);
app.use('/api/v1/audit', auditRoutes);
app.use('/api/v1/admin', adminRoutes);

// Error handler
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error'
  });
});

// Initialize services and start server
async function start() {
  try {
    // Initialize database connection
    await initializeDatabase();
    console.log('Database connected');

    // Initialize Redis
    await initializeRedis();
    console.log('Redis connected');

    // Initialize MinIO
    await initializeMinio();
    console.log('MinIO connected');

    app.listen(PORT, () => {
      console.log(`DocuSign backend running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();
