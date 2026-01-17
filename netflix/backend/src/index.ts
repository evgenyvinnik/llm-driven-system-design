import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import morgan from 'morgan';

import { SERVER_CONFIG } from './config.js';
import authRoutes from './routes/auth.js';
import profileRoutes from './routes/profiles.js';
import videoRoutes from './routes/videos.js';
import browseRoutes from './routes/browse.js';
import streamingRoutes from './routes/streaming.js';
import experimentRoutes from './routes/experiments.js';

const app = express();

// Middleware
app.use(cors({
  origin: SERVER_CONFIG.corsOrigin,
  credentials: true,
}));
app.use(express.json());
app.use(cookieParser());
app.use(morgan('dev'));

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/profiles', profileRoutes);
app.use('/api/videos', videoRoutes);
app.use('/api/browse', browseRoutes);
app.use('/api/stream', streamingRoutes);
app.use('/api/experiments', experimentRoutes);

// Error handling
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
const PORT = SERVER_CONFIG.port;

app.listen(PORT, () => {
  console.log(`Netflix API server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});

export default app;
